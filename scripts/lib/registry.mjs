import { WangganError } from "./core.mjs";

export function createRegistry() {
  const renderers = new Map();
  const operators = new Map();
  const constraintKinds = new Map();

  return {
    registerAssetRenderer(id, renderer) {
      if (!id || typeof id !== "string") throw new WangganError("renderer id 无效", { id });
      if (renderers.has(id)) throw new WangganError("renderer id 重复", { id });
      if (!renderer || typeof renderer.resolve !== "function") {
        throw new WangganError("renderer 必须提供 resolve", { id });
      }
      renderers.set(id, renderer);
    },
    registerEffectOperator(id, operator) {
      if (!id || typeof id !== "string") throw new WangganError("operator id 无效", { id });
      if (operators.has(id)) throw new WangganError("operator id 重复", { id });
      if (!operator || typeof operator.apply !== "function") {
        throw new WangganError("operator 必须提供 apply", { id });
      }
      operators.set(id, operator);
    },
    registerConstraintKind(id, evaluator) {
      if (!id || typeof id !== "string") throw new WangganError("constraint kind 无效", { id });
      if (constraintKinds.has(id)) throw new WangganError("constraint kind id 重复", { id });
      if (typeof evaluator !== "function") {
        throw new WangganError("constraint kind 必须是函数", { id });
      }
      constraintKinds.set(id, evaluator);
    },
    getRenderer(id) {
      const renderer = renderers.get(id);
      if (!renderer) throw new WangganError("未注册的 renderer", { id });
      return renderer;
    },
    getOperator(id) {
      const operator = operators.get(id);
      if (!operator) throw new WangganError("未注册的 operator", { id });
      return operator;
    },
    getConstraintKind(id) {
      const evaluator = constraintKinds.get(id);
      if (!evaluator) throw new WangganError("未注册的 constraint kind", { id });
      return evaluator;
    },
    hasRenderer(id) {
      return renderers.has(id);
    },
    hasOperator(id) {
      return operators.has(id);
    },
    hasConstraintKind(id) {
      return constraintKinds.has(id);
    },
    snapshot() {
      return {
        renderers: [...renderers.keys()],
        operators: [...operators.keys()],
        constraintKinds: [...constraintKinds.keys()],
      };
    },
  };
}

let builtinRegistry = null;

export function getBuiltinRegistry() {
  return builtinRegistry;
}

export function setBuiltinRegistry(registry) {
  builtinRegistry = registry;
  return registry;
}
