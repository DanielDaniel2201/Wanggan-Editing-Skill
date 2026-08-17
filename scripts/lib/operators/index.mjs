import { scaleOperator } from "./scale.mjs";
import { textStyleOperator } from "./text-style.mjs";
import { progressiveRevealOperator } from "./progressive-reveal.mjs";
import { opacityOperator } from "./opacity.mjs";
import { opacityEntryOperator, scaleEntryOperator, translateYEntryOperator } from "./entry-transition.mjs";

const OPERATORS = [
  scaleOperator,
  textStyleOperator,
  progressiveRevealOperator,
  opacityOperator,
  scaleEntryOperator,
  translateYEntryOperator,
  opacityEntryOperator,
];

export function registerBuiltinOperators(registry) {
  for (const operator of OPERATORS) {
    registry.registerEffectOperator(operator.id, operator);
  }
}

export function operatorPhase(operator) {
  return operator.phase || "style";
}
