// @ts-check
// Copied from wireon-process-editor src/elx/ir.js at ab525305d8ddd7dba7a5592e5cb79d3dbb159e8b; changes: none

/**
 * Intermediate Representation (IR) typedefs for ELX flows.
 *
 * No runtime code lives here — only JSDoc typedefs that other modules
 * import via `@typedef` references. VS Code's JS/TS language service
 * picks these up automatically.
 */

/**
 * @typedef {Object} Flow
 * @property {EngineConfig} engine
 * @property {PseudoNode[]} inputs       Top-level <input>
 * @property {PseudoNode[]} outputs      Top-level <output>
 * @property {NodeInstance[]} nodes      Regular <node>
 * @property {SubflowInstance[]} subflows  <filter> | <transformation>
 * @property {Net[]} nets
 */

/**
 * @typedef {Object} EngineConfig
 * @property {string} type               "flow"
 * @property {number} maxSteps
 * @property {boolean} recordHistory
 */

/**
 * @typedef {Object} PseudoNode
 * @property {"input"|"output"} kind
 * @property {string} name               Unique within scope
 * @property {TypedValue} [structure]    Optional baked-in value (inputs only)
 */

/**
 * @typedef {Object} NodeInstance
 * @property {string} id                 e.g. "directory.entries"
 * @property {string} plugin             e.g. "filesystem"
 * @property {string} name               Unique within scope; used by nets
 * @property {ParameterOverride[]} parameters
 * @property {PortConstant[]} constants  Including empty ones
 * @property {PortGroup[]} portGroups
 * @property {Extras} [extras]           Unknown attributes / children, verbatim
 */

/**
 * Round-trip bag for anything the parser didn't recognize on a node.
 * The serializer splices these back in. See CLAUDE.md "Round-trip
 * fidelity > clever IR".
 *
 * @typedef {Object} Extras
 * @property {Record<string,string>} attrs       Unknown attributes
 * @property {string[]} children                 Unknown children as XML source
 */

/**
 * @typedef {Object} SubflowInstance
 * @property {"filter"|"transformation"} kind
 * @property {string} id                 e.g. "structures.list.for-each"
 * @property {string} [plugin]
 * @property {string} name
 * @property {string} type               "standalone" in samples
 * @property {Flow} body                 Nested <elx>
 */

/**
 * @typedef {Object} PortConstant
 * @property {string} port               e.g. "in [0]", "separator", "error"
 * @property {TypedValue} [value]        Absent = intentionally unconnected
 */

/**
 * @typedef {Object} PortGroup
 * @property {string} id
 * @property {number} size
 */

/**
 * Parameter overrides carry a single literal (the widget value),
 * NOT a TypedValue. In the ELX they are `<parameter><value/></parameter>`
 * with no `<structure>` wrapper.
 *
 * @typedef {Object} ParameterOverride
 * @property {string} id
 * @property {ValueLiteral} value
 */

/**
 * @typedef {Object} TypedValue
 * @property {string} structure          "droplet"|"list"|"map"|"table"|"invalid"
 * @property {string} [plugin]
 * @property {ValueLiteral} [value]
 */

/**
 * @typedef {Object} ValueLiteral
 * @property {string} id                 "string"|"integer"|"boolean"|"json"|"filesystem path"|"error-code"
 * @property {string} [plugin]
 * @property {string} data               Raw text; typed lazily
 * @property {boolean} [cdata]           True if the source wrapped data in CDATA; serializer must re-emit CDATA
 */

/**
 * @typedef {Object} Net
 * @property {string} name
 * @property {NetConnection[]} connections
 */

/**
 * @typedef {Object} NetConnection
 * @property {string} node               Node name (or pseudo-node name)
 * @property {string} port
 */

export {};  // Make this a module so other files can reference its types.
