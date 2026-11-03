import { featureSchema, type CadDocument, type Feature, type Parameter } from '../shared/protocol';
import { CadError } from './document';

type Token = { kind: 'number'; value: number } | { kind: 'name'; value: string } | { kind: 'op'; value: string };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/()]))/y;
  let at = 0;
  while (at < text.length) {
    if (/^\s*$/.test(text.slice(at))) break;
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (!match) throw new CadError('INVALID_EXPRESSION', `Cannot read '${text.slice(at).trim()}' in '${text}'. Use numbers, parameter names, + - * / and parentheses.`);
    at = pattern.lastIndex;
    if (match[1] !== undefined) tokens.push({ kind: 'number', value: Number(match[1]) });
    else if (match[2] !== undefined) tokens.push({ kind: 'name', value: match[2] });
    else tokens.push({ kind: 'op', value: match[3] });
  }
  return tokens;
}

/** Parameter names an expression references, in order of appearance. Throws on unreadable text. */
export function expressionNames(text: string): string[] {
  return [...new Set(tokenize(text).filter(token => token.kind === 'name').map(token => token.value))];
}

/** Evaluate arithmetic over numbers and named values. A small recursive-descent parser; never runs code. */
export function evaluateExpression(text: string, values: ReadonlyMap<string, number>): number {
  const tokens = tokenize(text);
  let index = 0;
  const peek = () => tokens[index];
  const fail = (message: string): never => { throw new CadError('INVALID_EXPRESSION', `${message} in '${text}'.`); };
  const expression = (): number => {
    let value = term();
    while (peek()?.kind === 'op' && (peek()!.value === '+' || peek()!.value === '-')) value = tokens[index++].value === '+' ? value + term() : value - term();
    return value;
  };
  const term = (): number => {
    let value = factor();
    while (peek()?.kind === 'op' && (peek()!.value === '*' || peek()!.value === '/')) value = tokens[index++].value === '*' ? value * factor() : value / factor();
    return value;
  };
  const factor = (): number => {
    const token = tokens[index++];
    if (!token) return fail('Expression ends early');
    if (token.kind === 'number') return token.value;
    if (token.kind === 'name') {
      const value = values.get(token.value);
      if (value === undefined) return fail(`Unknown parameter '${token.value}'`);
      return value;
    }
    if (token.value === '-') return -factor();
    if (token.value === '+') return factor();
    if (token.value === '(') {
      const value = expression();
      if (tokens[index++]?.value !== ')') fail('Missing )');
      return value;
    }
    return fail(`Unexpected '${token.value}'`);
  };
  const value = expression();
  if (index < tokens.length) fail(`Unexpected '${tokens[index].value}'`);
  if (!Number.isFinite(value)) fail('Result is not a finite number (division by zero?)');
  return value;
}

export const parameterValues = (parameters: Parameter[] = []) => new Map(parameters.map(p => [p.name, p.value]));

/** Numeric leaf at a dotted params path, or undefined when the path does not name a number. */
export function valueAt(params: unknown, path: string): number | undefined {
  let node: unknown = params;
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'number' ? node : undefined;
}

/** A copy of params with one numeric leaf replaced. The path must already name a number. */
function withValueAt<T>(params: T, path: string, value: number): T {
  const copy = structuredClone(params);
  const keys = path.split('.');
  let node = copy as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
  node[keys.at(-1)!] = value;
  return copy;
}

/** Every binding that references a parameter, for usage counts and safe deletion. */
export function parameterUsage(document: CadDocument, name: string): { featureId: string; path: string }[] {
  return document.features.flatMap(feature => Object.entries(feature.bindings ?? {})
    .filter(([, text]) => { try { return expressionNames(text).includes(name); } catch { return false; } })
    .map(([path]) => ({ featureId: feature.id, path })));
}

/**
 * Rewrite every bound params value from the document's parameters, in place on the given copy.
 * Rejects unknown parameters, unreadable expressions, paths that do not name a number and out-of-range results,
 * naming the feature and field so a person or agent can correct it.
 */
export function resolveBindings(document: CadDocument): void {
  const names = new Set<string>();
  for (const parameter of document.parameters ?? []) {
    if (names.has(parameter.name)) throw new CadError('DUPLICATE_PARAMETER', `Parameter '${parameter.name}' is defined twice.`);
    names.add(parameter.name);
  }
  const values = parameterValues(document.parameters);
  document.features = document.features.map(feature => {
    if (!feature.bindings) return feature;
    let params = feature.params;
    for (const [path, text] of Object.entries(feature.bindings)) {
      if (valueAt(params, path) === undefined) throw new CadError('INVALID_BINDING', `Feature '${feature.id}' binds '${path}', which is not a numeric field of a ${feature.kind}.`, { featureId: feature.id, path });
      let value: number;
      try { value = evaluateExpression(text, values); }
      catch (error) { throw new CadError('INVALID_BINDING', `Feature '${feature.id}' field '${path}': ${error instanceof Error ? error.message : String(error)}`, { featureId: feature.id, path, expression: text }); }
      params = withValueAt(params, path, value);
    }
    const resolved = { ...feature, params } as Feature;
    const check = featureSchema.safeParse(resolved);
    if (!check.success) {
      const issue = check.error.issues[0];
      const issuePath = issue.path[0] === 'params' ? issue.path.slice(1).join('.') : '';
      // Cross-field refinements (e.g. rod endpoint distance) point at params, not a numeric leaf.
      const paths = Object.keys(feature.bindings).filter(path => !issuePath || path === issuePath || path.startsWith(issuePath + '.'));
      const fields = paths.length ? paths : issuePath ? [issuePath] : Object.keys(feature.bindings);
      const details = fields.map(path => `field 'params.${path}' resolves to ${String(valueAt(params, path) ?? 'an invalid value')} from '${feature.bindings![path] ?? 'its expression'}'`).join('; ');
      throw new CadError('BINDING_OUT_OF_RANGE', `Feature '${feature.id}' ${details}: ${issue.message}`, { featureId: feature.id, path: fields[0], paths: fields });
    }
    return resolved;
  });
}

/** Bindings whose paths still name numbers; used after a form reshapes params (fewer points, new profile type). */
export function pruneBindings(feature: Feature): Feature {
  if (!feature.bindings) return feature;
  const kept = Object.fromEntries(Object.entries(feature.bindings).filter(([path]) => valueAt(feature.params, path) !== undefined));
  const { bindings: _bindings, ...rest } = feature;
  return (Object.keys(kept).length ? { ...rest, bindings: kept } : rest) as Feature;
}

/** Set or clear one field: a number unbinds it, an expression binds it and stores its current value. */
export function withField(feature: Feature, path: string, value: number, expression?: string): Feature {
  const bindings = { ...(feature.bindings ?? {}) };
  if (expression === undefined) delete bindings[path]; else bindings[path] = expression;
  const { bindings: _bindings, ...rest } = feature;
  return { ...rest, params: withValueAt(feature.params, path, value), ...(Object.keys(bindings).length ? { bindings } : {}) } as Feature;
}
