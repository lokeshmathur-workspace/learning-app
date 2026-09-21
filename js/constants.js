// Life OS pillar keys — must match life-os/docs/SCHEMA.md's enum exactly,
// since actions this app writes to learning/queue.json flow into Life OS
// tasks. Display labels only; the stored key is always the left-hand value.
export const PILLARS = {
  finances: "Finances",
  careerWork: "Career & Work",
  business: "Business",
  personal: "Personal",
  vitality: "Vitality",
  relationships: "Relationships",
  mindGrowth: "Mind & Growth",
};

export const SOURCE_TYPES = {
  book: "Book",
  video: "Video",
  article: "Article",
  other: "Other",
};

// Capture status enum — see plan Phase G decision #6 for why needs_retake
// exists separately from needs_text (a photo with nothing readable, vs. a
// link the routine couldn't fetch).
export const CAPTURE_STATUS = {
  PENDING_TRANSCRIPTION: "pending_transcription",
  PENDING_SUMMARY: "pending_summary",
  READY: "ready",
  NEEDS_TEXT: "needs_text",
  NEEDS_RETAKE: "needs_retake",
};

export const QUEUE_ACTION_STATUS = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  DONE: "done",
  DISMISSED: "dismissed",
};

export const SOURCE_STATUS = {
  ACTIVE: "active",
  FINISHED: "finished",
};
