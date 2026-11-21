---
name: paper-knowledge
description: Identify transferable proof techniques and prerequisite definitions a reader could already know, and distinguish them from introductions made by the paper.
---

# Select knowledge for a mathematical paper

Read the actual proof and pick the few reusable moves that account for its reasoning. For each candidate identify the objects being transformed, compared, coupled, counted, or charged, why that move works here, and which steps use it. Give it the established mathematical name a researcher would recognize. A useful test is whether one can describe a second problem in which the same operation would advance a proof. Keep a single entry when several steps use the same mechanism. An empty selection is appropriate for a statement without an identifiable proof technique.

Describe the mechanism in conventional terms that a reader who has not opened the paper can recognize. Use a concrete example if it helps. Put the manuscript's particular instantiation in `knownBridge`. Explain which reasoning a reader familiar with the method can compress and which new hypothesis, change, or proof obligation needs attention here. The reader explicitly chooses which techniques they know. A familiar name, a previous paper, or a correct answer leaves that choice open.

Both global checklists contain concepts someone could recognize and know before opening this paper. Name techniques and definitions at their established, transferable level. Give each term its substantive, conventional meaning and group terms actually used together. Record the original one-based units where an entry is needed. In an undirected graph argument, double counting is a transferable method and vertex degree and incidence are transferable definitions.

Build the background cards from distinct concepts. Reuse one definition group in every part that needs it. Its title should make sense in a textbook on the subject with this manuscript removed. If a proposed title joins an established topic to a new rule or certificate, keep the established topic on the card and teach the new item at the passage that defines it. A familiar word can carry a new mathematical meaning here. Track its exact local predicate, threshold, tie-breaking rule or hypotheses. A standard term explicitly restated for clarity can still be background.

For each background card, use `selfCheck` for one optional application the reader can work through before opening the paper. Ask about a small example, boundary case or change of assumptions and give the concrete answer with a short reason. Use conventional terms, introduce any example data in the question and keep the check independent of paper-specific notation. Return null when there is no meaningful check. A reader's answer or choice to skip it carries no mastery claim.

Read the paper's introductions separately. A modified incidence count defined here, a named auxiliary graph particular to the construction, an invariant about that graph, or a bespoke way of converting its weights belongs among the paper's local introductions. Record where the reader learns it and send later uses back there. Even when a paper builds on a standard notion, separate the standard prerequisite from its local modification. For instance, knowing graph degree can shorten the definition of a modified count, while the reader still needs to learn exactly which edges receive extra weight. A restatement of a familiar standard definition can stay global. A locally proved result, its hypotheses and its role belong to this paper.

If a reader marks one definition known, compress only that definition. Other terms, assumptions, and conventions in the group remain available. Supply short stable IDs derived from the recognizable technique or group, `steps` tied to their actual use, and as few groups and techniques as the evidence warrants.
