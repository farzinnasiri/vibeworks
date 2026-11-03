import { chromium, type Browser, type Page } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { CadError } from "../cad/document";
import type { ContactSheetRenderer, MeshExporter } from "../cad/runtime";
import type { Evaluation } from "../cad/types";
import { packDisplay } from "../shared/display";

const RENDER_TIMEOUT_MS = 25_000;
const exec = promisify(execFile);
const require = createRequire(import.meta.url);
// Each build has its own service lifetime. A stopped esbuild service cannot poison later outputs.
async function buildOutput(): Promise<string> {
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e',
    `import { build } from ${JSON.stringify(require.resolve('esbuild'))};
     const result = await build({entryPoints:[${JSON.stringify(fileURLToPath(new URL('../web/output-entry.ts', import.meta.url)))}],bundle:true,write:false,format:'iife',platform:'browser',minify:true});
     process.stdout.write(result.outputFiles[0].text);`],
    { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}
class RejectedOutput extends CadError {}
/** Display arrays cross into Chromium encoded once per shared asset, not as JSON numbers per instance. */
const packed = (evaluation: Evaluation) =>
  (packDisplay({ result: {} as never, evaluation }) as { evaluation: unknown }).evaluation;

/** One managed display-only Chromium process; it never loads the kernel or the workspace UI. */
export class HeadlessRenderer {
  private bundle?: string;
  private browser?: Browser;
  private page?: Page;
  private queue = Promise.resolve();
  private pending = 0;
  private closed = false;
  private generation = 0;
  status: { phase: string; error?: string } = { phase: "idle" };
  private async initialize(): Promise<Page> {
    if (this.page && !this.page.isClosed() && this.browser?.isConnected()) return this.page;
    if (this.page || this.browser) await this.reset();
    if (this.closed)
      throw new CadError(
        "RENDERER_UNAVAILABLE",
        "The renderer is shutting down.",
      );
    this.status = { phase: "initializing" };
    const generation = this.generation;
    let browser: Browser | undefined;
    try {
      if (!this.bundle) {
        try { this.bundle = await buildOutput(); }
        catch (error) { throw new CadError('RENDERER_SERVICE', 'Output bundle preparation failed. Retry rendering to start a fresh build process. ' + String(error)); }
      }
      if (this.closed || generation !== this.generation)
        throw new CadError(
          "RENDERER_UNAVAILABLE",
          "Renderer initialization was cancelled.",
        );
      browser = await chromium.launch({
        headless: true,
        // Software WebGL on every machine; Chromium now requires the explicit opt-in.
        args: ["--use-angle=swiftshader", "--enable-webgl", "--enable-unsafe-swiftshader"],
      });
      if (this.closed || generation !== this.generation) {
        await browser.close();
        throw new CadError(
          "RENDERER_UNAVAILABLE",
          "Renderer initialization was cancelled.",
        );
      }
      this.browser = browser;
      const page = await browser.newPage();
      // Outputs use bundled code and in-memory data only, with no network dependencies.
      await page.route("**/*", (route) => route.abort());
      await page.setContent("<!doctype html><html><body></body></html>");
      await page.addScriptTag({ content: this.bundle });
      if (this.closed || generation !== this.generation) {
        await browser.close();
        throw new CadError(
          "RENDERER_UNAVAILABLE",
          "Renderer initialization was cancelled.",
        );
      }
      this.page = page;
      this.status = { phase: "ready" };
      return page;
    } catch (error) {
      await browser?.close().catch(() => {});
      if (generation === this.generation) {
        await this.reset();
        this.status = { phase: "unavailable", error: String(error) };
      }
      if (error instanceof CadError) throw error;
      const missing = /Executable doesn't exist|browser.*not found/i.test(String(error));
      throw new CadError(
        missing ? 'RENDERER_DEPENDENCY' : 'RENDERER_FAILED',
        (missing ? 'Install the pinned Chromium with npm run renderer:install. ' : 'Renderer initialization failed. Retry rendering to start a fresh browser. ') + String(error),
      );
    }
  }
  private run<T>(kind: "render" | "glb", args: unknown[], budgetMs = RENDER_TIMEOUT_MS): Promise<T> {
    if (this.closed)
      return Promise.reject(
        new CadError("RENDERER_UNAVAILABLE", "Renderer stopped."),
      );
    if (this.pending >= 8)
      return Promise.reject(
        new CadError(
          "RENDERER_BUSY",
          "The renderer has eight accepted outputs. Wait before submitting another.",
        ),
      );
    this.pending++;
    const accepted = Date.now();
    const action = async () => {
      const remaining = Math.min(RENDER_TIMEOUT_MS, budgetMs) - (Date.now() - accepted);
      if (remaining <= 0)
        throw new CadError(
          "RENDER_TIMEOUT",
          `Output expired before initialization after ${Date.now() - accepted} ms in the renderer queue; supplied budget ${Math.round(budgetMs)} ms.`,
        );
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          (async () => {
            const page = await this.initialize();
            return await page.evaluate(
              async ({ kind, args }) => {
                try {
                  return {
                    ok: true as const,
                    value: await (globalThis as any).__outputs[kind](...args),
                  };
                } catch (error) {
                  return {
                    ok: false as const,
                    code: (error as any).code ?? "RENDER_FAILED",
                    message: error instanceof Error ? error.message : String(error),
                  };
                }
              },
              { kind, args },
            );
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new CadError(
                    "RENDER_TIMEOUT",
                    `Headless rendering exceeded its ${Math.round(Math.min(RENDER_TIMEOUT_MS, budgetMs) / 1000)} s share of the command deadline.`,
                  ),
                ),
              remaining,
            );
          }),
        ]).then((result) => {
          if (!result.ok) throw new RejectedOutput(result.code, result.message);
          return result.value as T;
        });
      } catch (error) {
        // The page rejected this request (an invalid shot, an empty model); the renderer itself is fine.
        if (error instanceof RejectedOutput && error.code !== "RENDER_FAILED" && error.code !== "WEBGL_UNAVAILABLE") throw error;
        await this.reset();
        this.status = { phase: "unavailable", error: String(error) };
        if (error instanceof CadError) throw error;
        throw new CadError(
          "RENDER_FAILED",
          "Managed renderer failed: " + String(error),
        );
      } finally {
        clearTimeout(timer);
      }
    };
    const task = this.queue.then(action, action);
    this.queue = task.then(
      () => {},
      () => {},
    );
    return task.finally(() => {
      this.pending--;
    });
  }
  render: ContactSheetRenderer = (evaluation, command, document, health, budgetMs, comparisonBounds) =>
    this.run("render", [packed(evaluation), command, document, health, undefined, comparisonBounds], budgetMs);
  glb: MeshExporter = async (evaluation, document, featureIds, budgetMs) => {
    const result = await this.run<{ base64: string; mimeType: string }>(
      "glb",
      [packed(evaluation), document, featureIds],
      budgetMs,
    );
    const bytes = Buffer.from(result.base64, "base64");
    return {
      bytes: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ),
      mimeType: result.mimeType,
    };
  };
  private async reset() {
    this.generation++;
    const browser = this.browser;
    this.browser = undefined;
    this.page = undefined;
    await browser?.close().catch(() => {});
  }
  async close() {
    this.closed = true;
    await this.reset();
    await this.queue;
  }
}
