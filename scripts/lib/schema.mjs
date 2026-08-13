import Ajv from "ajv";
import addFormats from "ajv-formats";
import { WangganError } from "./core.mjs";

let ajv = null;

export function getAjv() {
  if (ajv) return ajv;
  ajv = new Ajv({
    allErrors: true,
    strict: false,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  return ajv;
}

export function compileSchema(schema, label) {
  try {
    return getAjv().compile(schema);
  } catch (error) {
    throw new WangganError(`${label} 的 JSON Schema 无效`, { cause: error.message });
  }
}

export function assertSchema(validator, value, label) {
  if (validator(value)) return value;
  const errors = (validator.errors || []).map((error) => ({
    path: error.instancePath || "/",
    message: error.message,
    params: error.params,
  }));
  throw new WangganError(`${label} 不符合 Schema`, { errors });
}

export async function loadAjvModules() {
  try {
    await import("ajv");
    await import("ajv-formats");
    getAjv();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      hint: "在 Skill 根目录运行 npm install，以安装 ajv 与 ajv-formats",
    };
  }
}
