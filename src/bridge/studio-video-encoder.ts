import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StudioVideoEncoding } from '../shared/protocol';

const MAX_OUTPUT = 64 * 1024 * 1024;
export const MAX_VIDEO_FRAME = 16 * 1024 * 1024;
export class VideoEncodingError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
interface Encoding {
  spec: StudioVideoEncoding; directory: string; output: string; child: ChildProcessWithoutNullStreams;
  done: Promise<{ code: number | null; error?: Error }>; frames: number; writing: boolean; finishing: boolean;
  timer: NodeJS.Timeout; stopped: boolean; stderr: string;
}

/** One local encoder, a bounded PNG pipe and one bounded temporary MP4. No geometry or shell execution. */
export class StudioVideoEncoder {
  get busy(){return !!this.active||!!this.starting;}
  private active?: Encoding;
  private starting?: Promise<{ id: string; frames: number }>;
  private startingId?: string;
  private closed = false;
  constructor(private executable = 'ffmpeg', private deadlineMs = 30 * 60_000) {}

  start(spec: StudioVideoEncoding) {
    if (this.closed) return Promise.reject(new VideoEncodingError(503, 'Video encoder is shutting down.'));
    if (this.starting) return Promise.reject(new VideoEncodingError(409, 'A video encoder is starting.'));
    if (this.active) {
      if (JSON.stringify(this.active.spec) === JSON.stringify(spec) && !this.active.stopped) return Promise.resolve({ id: spec.id, frames: this.active.frames });
      return Promise.reject(new VideoEncodingError(409, 'A video is already rendering. Finish or cancel it first.'));
    }
    this.startingId = spec.id;
    this.starting = this.create(spec).finally(() => { this.starting = undefined; this.startingId = undefined; });
    return this.starting;
  }
  private async create(spec: StudioVideoEncoding) {
    const directory = await mkdtemp(join(tmpdir(), 'vibeworks-video-'));
    const output = join(directory, 'video.mp4');
    const child = spawn(this.executable, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(spec.fps), '-i', 'pipe:0', '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-frames:v', String(spec.frames), '-movflags', '+faststart', '-fs', String(MAX_OUTPUT + 1024 * 1024), output],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    const done = new Promise<{ code: number | null; error?: Error }>(resolve => {
      child.once('error', error => resolve({ code: null, error }));
      child.once('close', code => resolve({ code }));
    });
    child.stdin.on('error', () => {}); child.stdout.resume();
    const job: Encoding = { spec: structuredClone(spec), directory, output, child, done, frames: 0, writing: false, finishing: false,
      timer: setTimeout(() => { void this.cancel(spec.id); }, this.deadlineMs), stopped: false, stderr: '' };
    job.timer.unref();
    child.stderr.on('data', chunk => { job.stderr = (job.stderr + chunk.toString()).slice(-2000); });
    this.active = job;
    try {
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      if (this.closed || job.stopped) throw new Error('Video was cancelled.');
      return { id: spec.id, frames: 0 };
    } catch {
      await this.cancel(spec.id);
      throw new VideoEncodingError(503, 'Could not start FFmpeg. Install FFmpeg with the libx264 encoder, then render again.');
    }
  }
  private require(id: string) {
    const job = this.active;
    if (!job || job.spec.id !== id || job.stopped) throw new VideoEncodingError(404, 'Video job is absent, cancelled or expired. Render again.');
    return job;
  }
  async frame(id: string, index: number, png: Buffer) {
    const job = this.require(id);
    if (job.writing || job.finishing || index !== job.frames || index >= job.spec.frames)
      throw new VideoEncodingError(409, 'Send video frames once, in order, before finishing.');
    if (png.length < 33 || png.length > MAX_VIDEO_FRAME || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.toString('ascii', 12, 16) !== 'IHDR'
      || png.readUInt32BE(16) !== job.spec.width || png.readUInt32BE(20) !== job.spec.height)
      throw new VideoEncodingError(400, 'Frame must be a PNG with the chosen video dimensions, at most 16 MiB.');
    job.writing = true;
    try {
      await new Promise<void>((resolve, reject) => job.child.stdin.write(png, error => error ? reject(error) : resolve()));
      if (job.stopped) throw new Error('Cancelled');
      job.frames++;
      return { id, frames: job.frames };
    } catch {
      await this.cancel(id);
      throw new VideoEncodingError(422, 'FFmpeg stopped accepting frames. Render again.');
    } finally { job.writing = false; }
  }
  async finish(id: string): Promise<Buffer> {
    const job = this.require(id);
    if (job.frames !== job.spec.frames || job.writing || job.finishing) throw new VideoEncodingError(409, 'All video frames must finish before encoding completes.');
    job.finishing = true; job.child.stdin.end();
    try {
      const result = await job.done;
      if (job.stopped) throw new VideoEncodingError(410, 'Video was cancelled or exceeded its 30-minute budget.');
      if (result.code !== 0 || result.error) throw new VideoEncodingError(422, `FFmpeg could not encode this video. ${job.stderr.slice(-500)}`);
      const size = (await stat(job.output)).size;
      if (size > MAX_OUTPUT || size < 32) throw new VideoEncodingError(413, 'Video exceeds its 64 MiB output budget. Use a shorter sequence.');
      return await readFile(job.output);
    } finally { await this.cancel(id); }
  }
  async cancel(id: string) {
    if (this.startingId === id && this.starting && !this.active) await this.starting.catch(() => {});
    const job = this.active;
    if (!job || job.spec.id !== id) return;
    job.stopped = true; clearTimeout(job.timer);
    job.child.stdin.destroy(); job.child.kill('SIGKILL');
    await job.done;
    await rm(job.directory, { recursive: true, force: true });
    if (this.active === job) this.active = undefined;
  }
  async close() {
    this.closed = true;
    await this.starting?.catch(() => {});
    if (this.active) await this.cancel(this.active.spec.id);
  }
}
