import type { ReviewPeriod } from "./types.ts";

// The review questions, shared by the web Reviews page and the Telegram evening review.
// Answers are stored in reviews.answers keyed by the question text, so the wording is the key.
export const REVIEW_QUESTIONS: Record<ReviewPeriod, string[]> = {
  daily: [
    "What moved forward today?",
    "What resisted or distracted me?",
    "What did I learn?",
    "What is tomorrow's single focus?",
  ],
  weekly: [
    "Which goals moved forward this week?",
    "Which commitments were missed?",
    "Where did my time actually go?",
    "Which life areas received attention — and which didn't?",
    "What did I learn?",
    "What remains unfinished, and what happens to it?",
    "What is the focus for next week?",
  ],
  monthly: [
    "How did this month's goals progress?",
    "What worked well and deserves repeating?",
    "What didn't work, and why?",
    "What will I adjust for next month?",
  ],
  quarterly: [
    "What did this quarter actually produce?",
    "Is the direction still right?",
    "What was the biggest lesson?",
    "What is the focus for next quarter?",
  ],
  yearly: [
    "How did the year serve my direction?",
    "What am I proudest of?",
    "What was hardest, and what did it teach me?",
    "What is the theme for next year?",
  ],
};
