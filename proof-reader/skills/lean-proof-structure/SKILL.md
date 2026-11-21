---
name: lean-proof-structure
description: Reconstruct a section of a mathematical paper as a dependency-ordered proof, formulate tractable local statements for Lean 4, and explain the argument in English from the checked statements and remaining paper obligations.
---

# Explain a paper through its proof obligations

Work from the original section, its exact claim, and the facts established earlier. Trace the section backward from what it needs to show. A useful module establishes something the reader can use next: existence of a witness, an invariant at a particular time, an obstruction, or the arithmetic that closes a contradiction. Keep a short argument short. For a definition section, explain how the definitions fit together and which properties still require proof.

## Formulate before explaining

Give each module a precise claim and a locator in the original paper. Name its premises in mathematical English, including the quantifier scope and any imported lemma. Record links to earlier modules whose output this step uses. These links describe the reading order. Enter an earlier result as an explicit Lean hypothesis whenever the local check uses it.

Choose a local proposition whose variables and hypotheses correspond to actual quantities and conditions. State this correspondence in the module's scope. A discrete example can illuminate a continuous theorem, but it covers only that instance. Keep units, strict inequalities, the meaning of subtraction, and nonzero denominators explicit where relevant. A packing contradiction, for example, may separate a combinatorial capacity bound from the final integer comparison. A check of that comparison takes the bound as a premise; the construction of the bound remains a separate obligation.

Use the reader's bounded formulation language for the supported fragment. Supply a typed expression and one allowed proof strategy. When the available language cannot represent the mathematical substance, leave the module as a source-grounded paper argument. Avoid a proposition that merely repeats the conclusion as a hypothesis, wraps the argument in an uninterpreted proposition, or substitutes a numerical instance without explaining its scope.

## Explain the checked result

Read the actual compiler result before writing the account. Compare its exact variables, assumptions and conclusion to the paper again. An accepted derivation establishes only the displayed proposition under its listed hypotheses. A failed tactic leaves an obligation open; failure alone gives no counterexample. If the model of the paper is incorrect, identify the mismatch and explain the argument from the source.

In each module, explain why the preceding step supplies the premise and how the present inference advances the goal. Introduce a symbol as the object it names first becomes necessary. Spell out the decisive substitution, case distinction or inequality, using familiar background to shorten only the steps the reader already knows. Keep the tool, its code and its diagnostics internal. Express any limitation in the reader's mathematical terms, such as “This calculation assumes the two counts apply to the same jobs.” Write a short overview connecting the modules into the paper's argument.
