import "dotenv/config";
import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import { google } from "googleapis";
import fs from "fs";

// =======================================================
// 1. CONFIGURATION & INITIALISATION
// =======================================================

const SERVICE_ACCOUNT_KEY_CONTENT = JSON.parse(
    process.env.SERVICE_ACCOUNT_KEY || fs.readFileSync("./google-service-account.json", "utf8")
);

admin.initializeApp({
    credential: admin.credential.cert(SERVICE_ACCOUNT_KEY_CONTENT), 
});
const db = admin.firestore();

const auth = new google.auth.GoogleAuth({
    credentials: SERVICE_ACCOUNT_KEY_CONTENT,
    scopes: ["https://www.googleapis.com/auth/calendar"],
});
const calendar = google.calendar({ version: "v3", auth });

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

const ADMIN_KEY = process.env.ADMIN_KEY || "Younes63";
const CALENDAR_ID = "msallaky@gmail.com";

// =======================================================
// 2. MAINTENANCE (Nettoyage automatique)
// =======================================================

async function cleanupOldAppointments() {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const limitDateString = sevenDaysAgo.toISOString().split('T')[0]; 
    try {
        const snapshot = await db.collection("appointments").where("date", "<=", limitDateString).get();
        if (snapshot.empty) return;
        const batch = db.batch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
    } catch (error) { console.error("❌ Erreur nettoyage:", error); }
}
cleanupOldAppointments();

// =======================================================
// 3. LOGIQUE DE VÉRIFICATION PAR MAIL (VIA FETCH API)
// =======================================================

function todayParisYYYYMMDD() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const d = parts.find(p => p.type === "day").value;
  return `${y}-${m}-${d}`; // YYYY-MM-DD
}

app.post("/api/verify-request", async (req, res) => {
  const { email, clientName, date, time, phone } = req.body;
  if (!email || !date || !time) {
    return res.status(400).json({ error: "Données manquantes" });
  }

  try {
    /* =================================================
       🔒 VÉRIFICATION RDV EXISTANT (AJOUT MINIMAL)
    ================================================= */

    // date du jour (Europe/Paris) au format YYYY-MM-DD
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    // on récupère tous les RDV de cet email (requête SIMPLE)
    const snapshot = await db
      .collection("appointments")
      .where("email", "==", email)
      .get();

    const hasFutureAppointment = snapshot.docs.some(doc => {
      const rdvDate = doc.data().date;
      return rdvDate >= today;
    });

    if (hasFutureAppointment) {
      return res.status(409).json({
        error: "Vous avez déjà un rendez-vous à venir. Merci d’attendre de l’avoir effectué avant d’en reprendre un."
      });
    }

    /* =================================================
       ✅ LOGIQUE D’ORIGINE (INCHANGÉE)
    ================================================= */

    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    await db.collection("temp_verifications").doc(email).set({
      otp,
      clientName,
      date,
      time,
      phone,
      createdAt: new Date()
    });

    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        accept: "application/json",
        "api-key": process.env.MAIL_PASS,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sender: { name: "YM Coiffure", email: "coiffureym63@outlook.com" },
        to: [{ email, name: clientName }],
        subject: "Confirmation de rendez-vous – YM Coiffure",
        htmlContent: `
          <div style="font-family:sans-serif;text-align:center;padding:20px">
            <h2>YM COIFFURE</h2>
            <p>Bonjour <b>${clientName}</b>,</p>
            <p>Votre code pour le rendez-vous du ${date} à ${time} :</p>
            <h1 style="background:#000;color:#fff;padding:10px;letter-spacing:8px">${otp}</h1>
            <p style="font-size:12px;color:#888">Code valable 15 minutes</p>
          </div>
        `
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(JSON.stringify(errorData));
    }

    console.log(`✅ Code OTP envoyé à ${email}`);
    return res.json({ success: true });

  } catch (error) {
    console.error("❌ Erreur verify-request:", error);
    return res.status(500).json({
      error: "Erreur technique, merci de réessayer."
    });
  }
});

// ÉTAPE 2 : Valider le code et créer le RDV
app.post("/api/verify-confirm", async (req, res) => {
    const { email, code } = req.body;
    try {
        const verifyDoc = await db.collection("temp_verifications").doc(email).get();
        if (!verifyDoc.exists || verifyDoc.data().otp !== code) {
            return res.status(400).json({ error: "Code invalide ou expiré" });
        }
        const data = verifyDoc.data();
        const startISO = `${data.date}T${data.time}:00`;
        const endDate = new Date(new Date(startISO).getTime() + 30 * 60000);
        
        const googleEvent = await calendar.events.insert({
            calendarId: CALENDAR_ID,
            requestBody: {
                summary: `✂️ ${data.clientName}`,
                description: `Tel: ${data.phone}\nMail: ${email}`,
                start: { dateTime: startISO, timeZone: "Europe/Paris" },
                end: { dateTime: endDate.toISOString().split('.')[0], timeZone: "Europe/Paris" },
            },
        });

        await db.collection("appointments").add({
            date: data.date, time: data.time, clientName: data.clientName,
            phone: data.phone, email: email, calendarEventId: googleEvent.data.id,
            createdAt: new Date()
        });

        await db.collection("temp_verifications").doc(email).delete();
        return res.json({ success: true, message: "Rendez-vous confirmé !" });
    } catch (error) {
        console.error("❌ Erreur confirmation:", error);
        return res.status(500).json({ error: "Erreur lors de la confirmation finale." });
    }
});

// =======================================================
// 4. ROUTES PUBLIQUES (Disponibilités)
// =======================================================

app.get("/api/status", async (req, res) => {
    try {
        const doc = await db.collection("settings").doc("status").get();
        res.json({ is_open: doc.exists ? doc.data().is_open : true });
    } catch (e) { res.json({ is_open: true }); }
});

app.get("/api/busy-slots", async (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: "Date manquante" });
    try {
        const snapshot = await db.collection("appointments").where("date", "==", date).get();
        const busySlots = snapshot.docs.map(doc => doc.data().time);
        res.json({ busySlots });
    } catch (e) { res.status(500).json({ error: "Erreur" }); }
});

// =======================================================
// 5. ROUTES ADMIN
// =======================================================

const checkAuth = (req, res, next) => {
    if (req.headers['x-admin-key'] === ADMIN_KEY) return next();
    res.status(401).json({ error: "Non autorisé" });
};

app.get("/api/admin/appointments", checkAuth, async (req, res) => {
    const snapshot = await db.collection("appointments").orderBy("date", "desc").get();
    res.json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
});

app.post("/api/admin/toggle-status", checkAuth, async (req, res) => {
    const { is_open } = req.body;
    await db.collection("settings").doc("status").set({ is_open });
    res.json({ success: true, is_open });
});

app.delete("/api/admin/appointment/:id", checkAuth, async (req, res) => {
    try {
        const doc = await db.collection("appointments").doc(req.params.id).get();
        if (doc.exists && doc.data().calendarEventId) {
            await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: doc.data().calendarEventId }).catch(()=>{});
        }
        await db.collection("appointments").doc(req.params.id).delete();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Erreur suppression" }); }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => console.log(`🚀 Serveur YM actif sur le port ${PORT}`));
