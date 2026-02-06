import { compile } from "json-schema-to-typescript";
import Ajv from "ajv";
import { cleanupVariableName, type BaseToolDefinition } from "@/shared/tool-types.ts";

const ajv = new Ajv.default();

/** Adds indentation to a given string */
function addIndentation(str: string, indent: number = 2): string {
  const indentation = " ".repeat(indent);
  return str
    .split("\n")
    .map((line) => (line.trim() ? indentation + line : line))
    .join("\n");
}

/** Finds matching closing brace accounting for nested braces and strings */
function findMatchingBrace(code: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let stringChar = "";
  for (let i = openIndex; i < code.length; i++) {
    const ch = code[i];
    const prev = code[i - 1];
    if ((ch === '"' || ch === "'" || ch === "`") && prev !== "\\") {
      if (!inString) {
        inString = true;
        stringChar = ch;
      } else if (ch === stringChar) {
        inString = false;
      }
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Extracts inline type definition from generated TypeScript interface code */
function extractInlineType(code: string): string {
  const start = code.indexOf("{");
  const end = findMatchingBrace(code, start);
  if (start === -1 || end === -1) throw new Error("Malformed interface");
  let body = code.slice(start + 1, end);
  body = body
    .replace(/\/\*\*?[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([^;{}])\s+([a-zA-Z_$][\w$]*\??:)/g, "$1; $2");
  return `{ ${body} }`;
}

/** Converts JSON schema to inline TypeScript type */
async function schemaToInlineType(
  schema: object,
  typeName: string,
): Promise<string> {
  const ts = await compile(schema, typeName, {
    bannerComment: "",
    format: false,
    additionalProperties: false,
  });
  return extractInlineType(ts);
}

/** Creates a runtime type guard function from a JSON schema using Ajv */
export function schemaToTypeGuard(schema: object): (value: unknown) => boolean {
  const validate = ajv.compile(schema);
  
  return function (value: unknown): boolean {
    return validate(value) as boolean;
  };
}

/** Generates JSDoc comment with function and parameter descriptions */
function generateJsDocComment(
  description?: string,
  paramDescriptions?: Record<string, string>,
): string {
  const lines: string[] = ["/**"];

  if (description) {
    lines.push(` * ${description}`);
    if (paramDescriptions && Object.keys(paramDescriptions).length > 0) {
      lines.push(" *");
    }
  }

  if (paramDescriptions) {
    for (const [paramName, paramDesc] of Object.entries(paramDescriptions)) {
      if (paramDesc) {
        lines.push(` * @param input.${paramName} - ${paramDesc}`);
      }
    }
  }

  lines.push(" */");
  return lines.join("\n");
}

/** Extracts parameter descriptions from JSON schema properties */
function extractParamDescriptions(
  schema: { properties?: Record<string, unknown> },
): Record<string, string> {
  const descriptions: Record<string, string> = {};

  if (schema?.properties && typeof schema.properties === "object") {
    for (const [key, value] of Object.entries(schema.properties)) {
      if (
        typeof value === "object" && value !== null && "description" in value
      ) {
        descriptions[key] = (value as { description: string }).description;
      }
    }
  }

  return descriptions;
}

/**
 * Generate TypeScript signature from any tool definition (MCP or WebSocket).
 * Accepts BaseToolDefinition which is the common interface for all tool types.
 */
export async function generateTsSignatureFromTool(
  tool: BaseToolDefinition,
): Promise<string> {
  const funcName = cleanupVariableName(tool.toolName);
  const inputType = await schemaToInlineType(tool.inputSchema, "InputType");

  let outputType = "";
  if (tool.outputSchema === null) {
    outputType = "void";
  } else if (tool.outputSchema === undefined) {
    outputType = "{ [k: string]: unknown }";
  } else {
    outputType = await schemaToInlineType(tool.outputSchema, "OutputType");
    if (outputType === "{ }") {
      outputType = "void";
    }
  }

  const paramDescriptions = extractParamDescriptions(
    tool.inputSchema as { properties?: Record<string, unknown> },
  );
  const jsDoc = generateJsDocComment(tool.description, paramDescriptions);

  return `${jsDoc}\n${funcName}(input: ${inputType}): Promise<${outputType}>;`;
}

/**
 * Generate a full TypeScript file with all tool signatures for a namespace.
 * Works with any tool type implementing BaseToolDefinition.
 */
export async function generateFullTsFile(
  source: string,
  tools: BaseToolDefinition[],
): Promise<string> {
  let fileText = `// Function signatures for ${source}\n\n`;

  fileText += `declare const ${cleanupVariableName(source)}: {\n`;

  const signatures = await Promise.all(tools.map(t => generateTsSignatureFromTool(t)));
  const indentedSignatures = signatures.map(sig => addIndentation(sig, 2)).join("\n");

  fileText += indentedSignatures;
  fileText += "\n};\n";
  return fileText;
}
