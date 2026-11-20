const express = require("express");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

const sessions = new Map();
const bookings = new Map();
const TTL_MS = 30 * 60 * 1000;
const PORT = process.env.PORT || 3000;
const OWNER_TOKEN = process.env.OWNER_TOKEN;

if (!OWNER_TOKEN || OWNER_TOKEN.length < 32) {
  console.error("OWNER_TOKEN must be configured with at least 32 characters.");
  process.exit(1);
}

function cleanExpired() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, session] of sessions) {
    if (session.updatedAt < cutoff || session.stopped) sessions.delete(id);
  }
}
setInterval(cleanExpired, 60_000).unref();

function ownerOnly(req, res, next) {
  const supplied = req.get("authorization") || "";
  const expected = "Bearer " + OWNER_TOKEN;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "غير مصرح" });
  }
  next();
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/api/sessions", (_req, res) => {
  cleanExpired();
  const id = crypto.randomUUID();
  const now = Date.now();
  sessions.set(id, { id, createdAt: now, updatedAt: now, latitude: null, longitude: null, accuracy: null, stopped: false });
  res.status(201).json({ id });
});

app.post("/api/sessions/:id/location", (req, res) => {
  cleanExpired();
  const session = sessions.get(req.params.id);
  if (!session || session.stopped) return res.status(404).json({ error: "انتهت جلسة المشاركة" });
  const { latitude, longitude, accuracy } = req.body || {};
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return res.status(400).json({ error: "إحداثيات غير صحيحة" });
  }
  session.latitude = latitude;
  session.longitude = longitude;
  session.accuracy = Number.isFinite(accuracy) ? Math.max(0, accuracy) : null;
  session.updatedAt = Date.now();
  res.json({ ok: true });
});

app.post("/api/bookings", (req, res) => {
  cleanExpired();
  const { sessionId, name, phone, vehicleType, pickupDate, returnDate, notes } = req.body || {};
  const session = sessions.get(sessionId);
  if (!session || !Number.isFinite(session.latitude) || !Number.isFinite(session.longitude)) {
    return res.status(403).json({ error: "يلزم تفعيل الموقع الجغرافي قبل إرسال طلب الحجز" });
  }
  const cleanName = typeof name === "string" ? name.trim().slice(0, 100) : "";
  const cleanPhone = typeof phone === "string" ? phone.replace(/[\\s-]/g, "").slice(0, 20) : "";
  const allowedTypes = ["اقتصادية", "سيدان", "عائلية / SUV", "فاخرة", "لا يهم"];
  if (!cleanName || !/^05\\d{8}$/.test(cleanPhone) || !allowedTypes.includes(vehicleType) ||
      !/^\\d{4}-\\d{2}-\\d{2}$/.test(pickupDate || "") ||
      !/^\\d{4}-\\d{2}-\\d{2}$/.test(returnDate || "") || returnDate < pickupDate) {
    return res.status(400).json({ error: "تحقق من الاسم والجوال ونوع السيارة وتواريخ الإيجار" });
  }
  const id = crypto.randomUUID();
  const booking = {
    id, name: cleanName, phone: cleanPhone, vehicleType,
    pickupDate, returnDate,
    notes: typeof notes === "string" ? notes.trim().slice(0, 500) : "",
    sessionId, latitude: session.latitude, longitude: session.longitude,
    createdAt: Date.now()
  };
  bookings.set(id, booking);
  res.status(201).json({ ok: true, bookingId: id });
});

app.post("/api/sessions/:id/stop", (req, res) => {
  const session = sessions.get(req.params.id);
  if (session) sessions.delete(req.params.id);
  res.json({ ok: true });
});

app.get("/api/owner/sessions", ownerOnly, (_req, res) => {
  cleanExpired();
  const active = [...sessions.values()]
    .filter(s => Number.isFinite(s.latitude) && Number.isFinite(s.longitude))
    .map(({ id, createdAt, updatedAt, latitude, longitude, accuracy }) =>
      ({ id, createdAt, updatedAt, latitude, longitude, accuracy }));
  res.set("Cache-Control", "no-store");
  res.json({ sessions: active });
});

app.get("/api/owner/bookings", ownerOnly, (_req, res) => {
  res.set("Cache-Control", "no-store");
  const items = [...bookings.values()].sort((a, b) => b.createdAt - a.createdAt);
  res.json({ bookings: items });
});

app.delete("/api/owner/bookings/:id", ownerOnly, (req, res) => {
  bookings.delete(req.params.id);
  res.json({ ok: true });
});

app.delete("/api/owner/sessions/:id", ownerOnly, (req, res) => {
  sessions.delete(req.params.id);
  res.json({ ok: true });
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log("MAJD location service listening on " + PORT));
