import { scaleOperator } from "./scale.mjs";
import { textStyleOperator } from "./text-style.mjs";
import { progressiveRevealOperator } from "./progressive-reveal.mjs";
import { popOperator } from "./pop.mjs";
import { opacityOperator } from "./opacity.mjs";
import { translateOpacityOperator } from "./translate-opacity.mjs";

const OPERATORS = [
  scaleOperator,
  textStyleOperator,
  progressiveRevealOperator,
  popOperator,
  opacityOperator,
  translateOpacityOperator,
];

export function registerBuiltinOperators(registry) {
  for (const operator of OPERATORS) {
    registry.registerEffectOperator(operator.id, operator);
  }
}

export function operatorPhase(operator) {
  return operator.phase || "style";
}
