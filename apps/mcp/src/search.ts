// `search` and the TypeScript declarations of Orbis Code Mode (PAL-3053): what an agent reads
// before it writes a program. Each declaration comes from the capability's own Schemas.
import { Predicate, Schema } from "effect";
import type { JsonSchema } from "effect/JsonSchema";

import { catalog, namespaces } from "./catalog.js";
import type { Capability } from "./catalog.js";

/** Past this depth a type prints as `Json`, so one large output stays a short declaration. */
const maxDepth = 4;

const isSchema: (value: unknown) => value is JsonSchema = Predicate.isObject;

const nonFinite = new Set(["Infinity", "-Infinity", "NaN"]);

/**
 * Effect's JSON Schema of a number is `number`, or one of the strings `Infinity`, `-Infinity`, `NaN`.
 * Beside a `number`, those strings print as nothing, so a nullable number reads `number | null`.
 */
const withoutNumberForms = (variants: readonly JsonSchema[]) =>
  variants.some((each) => each.type === "number" || each.type === "integer")
    ? variants.filter(
        (each) =>
          !(
            each.type === "string" &&
            Array.isArray(each.enum) &&
            each.enum.every((value) => nonFinite.has(String(value)))
          )
      )
    : variants;

const propertyName = (name: string) =>
  /^[A-Za-z_$][\w$]*$/u.test(name) ? name : JSON.stringify(name);

const scalars = new Map([
  ["boolean", "boolean"],
  ["integer", "number"],
  ["null", "null"],
  ["number", "number"],
  ["string", "string"],
]);

/** A TypeScript type for one JSON Schema. */
export const typeOf = (schema: JsonSchema, depth = 0): string => {
  const inner = (child: JsonSchema) => typeOf(child, depth + 1);
  const objectType = () => {
    const properties = isSchema(schema.properties) ? schema.properties : {};
    const required = new Set(
      Array.isArray(schema.required) ? schema.required : []
    );
    const fields = Object.entries(properties).flatMap(([name, value]) =>
      isSchema(value)
        ? [
            `${propertyName(name)}${required.has(name) ? "" : "?"}: ${inner(value)}`,
          ]
        : []
    );
    if (fields.length === 0 && isSchema(schema.additionalProperties)) {
      return `Record<string, ${inner(schema.additionalProperties)}>`;
    }
    return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`;
  };
  const arrayType = () => {
    const items = isSchema(schema.items) ? inner(schema.items) : "Json";
    return items.includes(" ") ? `Array<${items}>` : `${items}[]`;
  };
  const union = schema.anyOf ?? schema.oneOf;
  const variants = Array.isArray(union) ? union.filter(isSchema) : [];
  if (depth > maxDepth) {
    return "Json";
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((each) => JSON.stringify(each)).join(" | ");
  }
  if ("const" in schema) {
    return JSON.stringify(schema.const);
  }
  if (variants.length > 0) {
    return [...new Set(withoutNumberForms(variants).map(inner))].join(" | ");
  }
  if (schema.type === "array") {
    return arrayType();
  }
  if (schema.type === "object") {
    return objectType();
  }
  return scalars.get(String(schema.type)) ?? "Json";
};

const jsonSchemaOf = (schema: Schema.Top) =>
  Schema.toJsonSchemaDocument(schema).schema;

/** One capability's declaration: its doc comment and its signature. */
export const declarationOf = (capability: Capability): string => {
  const input = jsonSchemaOf(capability.input);
  const fields = isSchema(input.properties)
    ? Object.keys(input.properties)
    : [];
  const required = Array.isArray(input.required) && input.required.length > 0;
  const parameter =
    fields.length === 0 ? "" : `input${required ? "" : "?"}: ${typeOf(input)}`;
  return `/** ${capability.description} */\nfunction ${capability.name}(${parameter}): Promise<${typeOf(jsonSchemaOf(capability.output))}>;`;
};

/** Every namespace and capability as one TypeScript declaration file. */
export const declarations = (): string =>
  [
    "type Json = null | boolean | number | string | Json[] | { [key: string]: Json };",
    ...Object.entries(namespaces).map(([namespace, description]) => {
      const body = catalog
        .filter((each) => each.namespace === namespace)
        .map((each) => declarationOf(each).replaceAll(/^/gmu, "  "))
        .join("\n");
      return `/** ${description} */\ndeclare namespace ${namespace} {\n${body}\n}`;
    }),
  ].join("\n\n");

export interface SearchQuery {
  readonly limit?: number | undefined;
  readonly namespace?: string | undefined;
  readonly offset?: number | undefined;
  readonly query?: string | undefined;
}

export interface SearchHit {
  readonly declaration: string;
  readonly description: string;
  readonly namespace: string;
  readonly path: string;
}

export interface SearchResult {
  readonly limit: number;
  readonly namespaces: Readonly<Record<string, string>>;
  readonly offset: number;
  readonly results: readonly SearchHit[];
  readonly total: number;
}

/** How many of the query's words a capability's path and description hold; 0 drops it. */
const score = (capability: Capability, words: readonly string[]) => {
  const text = `${capability.path} ${capability.description}`.toLowerCase();
  return (
    words.filter((word) => text.includes(word)).length +
    (words.some((word) => capability.path.toLowerCase().includes(word)) ? 1 : 0)
  );
};

/**
 * The capabilities that match `query` (any of its words, in the path or the description, best
 * first) in `namespace`, a page of `limit` (default 20, at most 100) from `offset`.
 */
export const search = (query: SearchQuery = {}): SearchResult => {
  const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 20)));
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const words = (query.query ?? "")
    .toLowerCase()
    .split(/[\s.,]+/u)
    .filter((word) => word.length > 0);
  const matches = catalog
    .filter(
      (each) =>
        query.namespace === undefined || each.namespace === query.namespace
    )
    .map((each) => ({
      each,
      score: words.length === 0 ? 1 : score(each, words),
    }))
    .filter(({ score: points }) => points > 0)
    .toSorted((a, b) => b.score - a.score);
  return {
    limit,
    namespaces,
    offset,
    results: matches.slice(offset, offset + limit).map(({ each }) => ({
      declaration: declarationOf(each),
      description: each.description,
      namespace: each.namespace,
      path: each.path,
    })),
    total: matches.length,
  };
};
