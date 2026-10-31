// The RightClick X data model.
//
// A Capability is a typed node: it consumes semantic values on its input
// ports and produces semantic values on its output ports. Because every
// reflector (OpenAPI, GraphQL, MCP, web, platform, peer) lands capabilities in
// this one shape, capabilities from unrelated providers and protocols can be
// chained by the planner without anyone writing glue code.

/** A semantic type such as "url", "text", "language", "geo.lat", "list:url". */
export type SemType = string;

import type { OutcomeWitness, Predicate } from "./verify.ts";

export interface Port {
  /** Input: argument name. Output: dotted path into the result ("" = whole result). */
  name: string;
  type: SemType;
  required: boolean;
  description?: string;
  /** Raw source schema type, when the source declares one (e.g. "String!", "integer"). */
  wire?: string;
  /** Allowed values, when the source declares an enum. Only the caller can choose one. */
  enum?: string[];
  /**
   * Identifier schemes this port was observed to carry (see core/identities.ts): an input
   * accepts a value from any output that feeds one of its schemes. Learned, never declared.
   */
  schemes?: string[];
  /** An output path the contract does not declare, observed in real results; not part of the contract signature. */
  observed?: boolean;
  /** Input established (by experiment) to accept any kind of text, markup included. */
  anyText?: boolean;
}

export type SourceKind =
  | "builtin"
  | "openapi"
  | "graphql"
  | "mcp"
  | "web"
  | "platform"
  | "composite"
  | "peer"
  | "cli";

/** Destructive operations require confirmation; callers can constrain allowed risks. */
export type Risk = "read" | "write" | "external" | "destructive";

/** A required operation's role, retained across protocol/port-name changes.
 * Matching is deliberately exact and source-bound, never a fuzzy replacement.
 */
export interface CapabilityAnchor {
  id: string;
  source?: string;
  title: string;
  risk: Risk;
  inputTypes: SemType[];
  outputTypes: SemType[];
  /** What the id invoked when pinned (method and path below the base, GraphQL field or MCP tool). Absent on older pins. */
  operation?: string;
}

export interface HttpInvoke {
  kind: "http";
  method: string;
  /** Absolute URL template; {name} segments are path parameters. */
  url: string;
  pathParams: string[];
  queryParams: string[];
  headerParams: string[];
  /** "json" sends bodyParams as a JSON object; "raw" sends the single "body" input. */
  body: "json" | "form" | "raw" | null;
  bodyParams: string[];
  /** Fixed values always sent (e.g. hidden form fields). */
  constants?: Record<string, string>;
  /** Path params whose "/" must stay literal (OpenAPI x-multi-segment, e.g. git refs "heads/main"). */
  multiSegment?: string[];
  /** Keyed-map projection: the result is response[map][args[keyInput]]; keyInput is never sent. */
  entry?: { map: string; keyInput: string };
}

/** Local protocol evidence, not an authority grant or proof of absent effects. */
export interface GraphQLFailureEvidence {
  kind: "invalid-document" | "execution-errors" | "invalid-response";
  reason: string;
  capability?: string;
  runs: string[];
}

export interface GraphQLInvoke {
  kind: "graphql";
  endpoint: string;
  operation: "query" | "mutation";
  field: string;
  /** Argument name -> GraphQL type literal, e.g. { code: "ID!" }. */
  args: Record<string, string>;
  selection: string;
  /** Optional input port through which a caller replaces the default selection set. */
  selectPort?: string;
}

export interface McpInvoke {
  kind: "mcp";
  endpoint: string;
  tool: string;
}

export interface BuiltinInvoke {
  kind: "builtin";
  fn: string;
}

export interface PlatformInvoke {
  kind: "platform";
  fn: string;
}

export interface PeerInvoke {
  kind: "peer";
  endpoint: string;
  id: string;
}

export interface Binding {
  /** Input port of this step. */
  port: string;
  /** A constant chosen by the planner (e.g. a GraphQL selection for required fields); `from` is "$const". */
  value?: unknown;
  /** Either a goal input ("$in.<name>") or "<stepIndex>.<outputPath>". */
  from: string;
  /** Exact declared relationship, checked against the producing HTTP response before extraction. */
  link?: { name: string; status: number; pointer: string; wire: "string" | "number" | "integer" | "boolean"; format?: "uuid" | "uri" };
  /**
   * Fan-out: `from` is a list and this single-value port takes one item at a time. The step
   * runs once per item, in order, and each of its outputs becomes the list of per-item outputs.
   * More than `max` items refuses the step. With `shapes`, only items of those identifier shapes
   * (see core/identities.ts) are used, because the list was linked by a learned scheme.
   */
  each?: { max: number; shapes?: string[] };
}

/** Directed contract evidence; never an identifier equivalence or execution grant. */
export interface ContractLink {
  name: string;
  target: string;
  status: number;
  parameters: Array<{ port: string; pointer: string; wire: "string" | "number" | "integer" | "boolean"; format?: "uuid" | "uri" }>;
}

export interface PlanStep {
  capability: string;
  bindings: Binding[];
}

export interface CompositeInvoke {
  kind: "composite";
  steps: PlanStep[];
  /** Where the final value is read from: "<stepIndex>.<outputPath>". */
  result: string;
  /** Contract signature of each step when the pipeline was proven; a mismatch retires it. */
  signatures?: string[];
  /** Checks travel with a saved capability and run on every new invocation. */
  verify?: Predicate[];
  require?: string[];
  witnesses?: OutcomeWitness[];
  /** Caller restrictions and observed preservation obligations survive reuse. */
  origins?: string[];
  preserveInputs?: string[];
}

export interface GoalInvoke {
  kind: "goal";
  slug: string;
}

/** A local command-line program, run only inside the host sandbox. */
export interface CliInvoke {
  kind: "cli";
  bin: string;
  /**
   * argv after the program: literal flags; {input} placeholders materialised as files; and
   * {input, literal} placeholders passed as argument text (patterns, sets, numbers).
   */
  args: Array<string | { input: string; literal?: boolean }>;
  /**
   * The documented-options interface: the caller may pass options from this declared list (and
   * their arguments) in the input named `port`; anything else is refused before running.
   * These are placed before `args`: group-level options, or a program's only options.
   */
  options?: { port: string; allowed: Array<{ flags: string[]; arg: boolean; optionalArg?: boolean }>; excluded?: string[] };
  /**
   * Documented options placed after `args`. A subcommand's own options belong after the verb
   * when a program requires `prog [global options] verb [verb options] [files]`.
   */
  optionsAfterArgs?: { port: string; allowed: Array<{ flags: string[]; arg: boolean; optionalArg?: boolean }>; excluded?: string[] };
  /** Input holding named files ({name: content}) written exactly into the sandbox. */
  filesPort?: string;
  /** Optional list of named files to append as operands, in order. Omitted means all files; [] means none. */
  operandsPort?: string;
  /** Input whose value is written to stdin. */
  stdin?: string;
  /** Exit codes observed together with real output for valid input. */
  okExit: number[];
  output: "text" | "json" | "html" | "xml";
  /** SHA-256 of the program when it was investigated; a different program is not run as this. */
  sha256: string;
  /** Local environment pin, never proof of complete execution dependency coverage. */
  environment?: { version: 1; coverage: "partial"; digest: string };
  /**
   * Behaviour fingerprint: a digest of the outputs this mode produced for the investigator's fixed
   * synthetic inputs. Two investigations with the same fingerprint observed the same behaviour, so
   * a new file (another version, a wrapper) that keeps it is the same capability, and one that
   * changes it is not.
   */
  behaviour?: string;
  /**
   * Conformance examples: synthetic inputs from the investigation and the digest of the output
   * they produced. Re-running them (in the sandbox) revalidates the capability somewhere else or
   * after a change, without repeating the whole investigation.
   */
  examples?: Array<{ stdin?: string; files?: Record<string, string>; literals?: string[]; outputSha256: string; outputPreview: string }>;
  /** Local operation identities retained across inference upgrades by matching old examples
   * against fresh evidence for the same binary and invocation contract. Not portable authority
   * or universal semantic equivalence; export/import removes this local lineage. */
  continuity?: Array<{ behaviour: string; examples: NonNullable<CliInvoke["examples"]> }>;
  /** Output values that vary between identical runs (file timestamps) and are normalised in fingerprints. */
  volatile?: "timestamps";
}

export type Invoke =
  | CliInvoke
  | HttpInvoke
  | GraphQLInvoke
  | McpInvoke
  | BuiltinInvoke
  | PlatformInvoke
  | PeerInvoke
  | GoalInvoke
  | CompositeInvoke;

/** A field the provider's contract declares in this capability's result (paths may cross arrays). */
export interface DeclaredField {
  path: string;
  /** Semantic type when the contract describes a selectable scalar leaf. */
  type?: SemType;
  /** For providers that choose what to return (GraphQL): whether the default request selects it. */
  selected?: boolean;
}

export interface Capability {
  id: string;
  title: string;
  description: string;
  provider: string;
  source: SourceKind;
  inputs: Port[];
  outputs: Port[];
  risk: Risk;
  tags: string[];
  invoke: Invoke;
  /** Result fields the contract declares (deeper than the output ports); used to judge goal satisfaction. */
  fields?: DeclaredField[];
  links?: ContractLink[];
}

export interface Provider {
  id: string;
  title: string;
  source: SourceKind;
  origin: string;
  learnedAt: string;
  capabilityIds: string[];
  meta?: Record<string, unknown>;
}

export interface Reflection {
  provider: Provider;
  capabilities: Capability[];
}

/** Local transport observation, never a credential or proof of authority.
 * capabilityId identifies the owning run, including its monitor/redirect requests,
 * not necessarily the operation performed by each HTTP request. Not persisted. */
export interface TransportContext {
  readonly runtimeId: string;
  readonly runId: string;
  readonly capabilityId: string;
  readonly requestId: string;
}
export type FetchLike = (input: string | URL | Request, init?: RequestInit, context?: TransportContext) => Promise<Response>;

/** A host transport reports refusal, not a provider failure or an authority grant. */
export interface TransportRefusal {
  reason: string;
  capability?: string;
  runs: string[];
}
