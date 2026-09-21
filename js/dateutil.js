// Trimmed port of lifeos-app's js/dateutil.js — only what learning-app
// actually needs (no week/month math, Learning has no weekly/monthly
// periods of its own). Same America/Los_Angeles TZ convention, so a capture
// timestamped just after midnight still lands on the day Lokesh experienced
// it as, matching Life OS's own documented reasoning for this choice.
export const TZ = "America/Los_Angeles";

const fmtISO = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const todayISO = () => fmtISO.format(new Date());

export const nowHM = () =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());

export const nowStamp = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date())
    .replace(/[^\d]/g, "")
    .slice(0, 12); // YYYYMMDDHHMM — used in inbox/ photo filenames

export const D = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

export const prettyDate = (dateISO) => {
  const d = D(dateISO);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(d);
};

export const shortDate = (dateISO) => {
  const d = D(dateISO);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(d);
};

export const fmtRelative = (isoOrTimestamp) => {
  if (!isoOrTimestamp) return "";
  const d = isoOrTimestamp.length === 10 ? D(isoOrTimestamp) : new Date(isoOrTimestamp);
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" }).format(d);
};
