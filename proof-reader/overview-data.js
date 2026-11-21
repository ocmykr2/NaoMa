(() => {
  "use strict";

  const guides = {
    intervals: {
      kind: "guide",
      paragraphs: [
        "You have one machine and a list of activities with fixed start and finish times. Each completed activity counts once. Which activities should you accept to fit as many as possible?",
        "Pick the available activity that finishes first, then repeat with activities that still fit. The proof starts from an optimal schedule and swaps in this first choice. Every later activity keeps its place, so the count stays the same. Repeating the argument proves that the greedy schedule is optimal."
      ],
      suggestions: [
        {
          question: "Why choose the earliest finish instead of the earliest start?", step: 1,
          answer: "Take three activities running from 0 to 4, from 1 to 2, and from 2 to 3. Picking the earliest start occupies the machine for all four units. Picking the earliest finish lets the two shorter activities run back to back."
        },
        {
          question: "What exactly survives the exchange?", step: 2,
          answer: "Suppose the first activity in an optimal schedule is X. Replace it with the greedy choice G. Since G finishes no later than X, every activity that followed X still fits. We replaced one activity with one activity, so the number completed is unchanged."
        },
        {
          question: "Would this still work if some activities paid more?", step: 2,
          answer: "Consider two overlapping activities. The one from 0 to 2 pays 1, and the one from 1 to 3 pays 10. Earliest finish picks the first. The exchange preserves the number of activities, but it can lose reward. The theorem assumes that each activity counts equally."
        }
      ]
    }
  };

  window.PAPER_OVERVIEW = {
    get({paperId,research}) {
      if (Object.hasOwn(guides,paperId)) return guides[paperId];
      return window.READER_SESSION.isPrepared(research) ? research.overview : null;
    }
  };
})();
