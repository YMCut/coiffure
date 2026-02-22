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
    const today = new Date().toISOString().split('T')[0]; 
    try {
        const snapshot = await db.collection("appointments").where("date", "<", today).get();
        if (snapshot.empty) return;
        const batch = db.batch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        console.log(`✅ Nettoyage : ${snapshot.size} anciens RDV supprimés.`);
    } catch (error) { 
        console.error("❌ Erreur nettoyage:", error); 
    }
}
cleanupOldAppointments();

// =======================================================
// 3. LOGIQUE DE VÉRIFICATION ET ENVOI OTP
// =======================================================

app.post("/api/verify-request", async (req, res) => {
    const { email, clientName, date, time, phone } = req.body;
    if (!email || !date || !time) return res.status(400).json({ error: "Données manquantes" });

    try {
        // 1. VÉRIFICATION DOUBLON (PROPRE)
        const todayParis = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Europe/Paris",
            year: "numeric", month: "2-digit", day: "2-digit",
        }).format(new Date());

        const snapshot = await db.collection("appointments").where("email", "==", email).get();
        const existingRDV = snapshot.docs.find(doc => doc.data().date >= todayParis);

        if (existingRDV) {
            const rdv = existingRDV.data();
            return res.json({ 
                success: false, 
                isDuplicate: true,
                message: `Vous avez déjà un rendez-vous prévu le ${rdv.date} à ${rdv.time}.`,
                suggestion: "Merci d'honorer ce créneau avant d'en réserver un nouveau."
            });
        }

        // 2. GÉNÉRATION OTP
        const otp = Math.floor(1000 + Math.random() * 9000).toString();
        await db.collection("temp_verifications").doc(email).set({
            otp, clientName, date, time, phone,
            createdAt: new Date()
        });

        // 3. ENVOI VIA BREVO (FETCH API)
        const response = await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: {
                "accept": "application/json",
                "api-key": process.env.MAIL_PASS,
                "content-type": "application/json"
            },
            body: JSON.stringify({
                sender: { name: "YM Coiffure", email: "coiffureym63@outlook.com" },
                to: [{ email: email, name: clientName }],
                subject: "Confirmation de rendez-vous – YM Coiffure",
                htmlContent: `
                    <div style="font-family: sans-serif; text-align: center; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
                        <h2 style="color: #333;">YM COIFFURE</h2>
                        <p>Bonjour <b>${clientName}</b>,</p>
                        <p>Voici votre code pour confirmer votre rendez-vous du ${date} à ${time} :</p>
                        <h1 style="background: #000; color: #fff; padding: 15px; letter-spacing: 10px; display: inline-block;">${otp}</h1>
                        <p style="font-size: 12px; color: #888; margin-top: 20px;">Ce code expire dans 15 minutes.</p>
                    </div>`
            })
        });

        if (!response.ok) throw new Error("Erreur lors de l'appel à l'API Brevo");

        console.log(`✅ Code OTP envoyé à ${email}`);
        return res.json({ success: true, message: "Code envoyé !" });

    } catch (error) {
        console.error("❌ Erreur verify-request:", error);
        return res.status(500).json({ error: "Erreur technique, merci de réessayer." });
    }
});

// =======================================================
// 4. CONFIRMATION FINALE DU RDV
// =======================================================

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
        
        // Ajout Google Calendar
        const googleEvent = await calendar.events.insert({
            calendarId: CALENDAR_ID,
            requestBody: {
                summary: `✂️ ${data.clientName}`,
                description: `Tel: ${data.phone}\nMail: ${email}`,
                start: { dateTime: startISO, timeZone: "Europe/Paris" },
                end: { dateTime: endDate.toISOString().split('.')[0], timeZone: "Europe/Paris" },
            },
        });

        // Sauvegarde Firestore
        await db.collection("appointments").add({
            date: data.date, time: data.time, clientName: data.clientName,
            phone: data.phone, email: email, calendarEventId: googleEvent.data.id,
            createdAt: new Date()
        });

        await db.collection("temp_verifications").doc(email).delete();
        return res.json({ success: true, message: "Rendez-vous confirmé !" });

    } catch (error) {
        console.error("❌ Erreur confirmation:", error);
        return res.status(500).json({ error: "Impossible de finaliser le rendez-vous." });
    }
});

// =======================================================
// 5. ROUTES PUBLIQUES & ADMIN
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
        res.json({ busySlots: snapshot.docs.map(doc => doc.data().time) });
    } catch (e) { res.status(500).json({ error: "Erreur" }); }
});

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