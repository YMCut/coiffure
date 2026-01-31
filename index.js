import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import { google } from "googleapis";
import nodemailer from "nodemailer";
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

// Configuration Outlook
const transporter = nodemailer.createTransport({
    host: "smtp-mail.outlook.com",
    port: 587,
    secure: false, // TLS
    auth: {
        user: 'coiffureym63@outlook.com',
        pass: process.env.EMAIL_PASS // Utilise une variable d'environnement sur Render
    },
    tls: { ciphers: 'SSLv3' }
});

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

const ADMIN_KEY = process.env.ADMIN_KEY || "Younesladinde";
const CALENDAR_ID = "msallaky@gmail.com";

// =======================================================
// 2. LOGIQUE DE VÉRIFICATION PAR MAIL (OTP)
// =======================================================

// ÉTAPE 1 : Demander un code de vérification
app.post("/api/verify-request", async (req, res) => {
    const { email, clientName, date, time, phone } = req.body;
    const userIp = req.ip || req.headers['x-forwarded-for'];

    if (!email || !date || !time) return res.status(400).json({ error: "Données manquantes" });

    try {
        // Anti-spam IP : Pas plus de 3 demandes de code par heure
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const ipCheck = await db.collection("temp_verifications")
            .where("ip", "==", userIp)
            .where("createdAt", ">", oneHourAgo)
            .get();

        if (ipCheck.size >= 3) return res.status(429).json({ error: "Trop de tentatives. Réessayez plus tard." });

        const otp = Math.floor(1000 + Math.random() * 9000).toString();

        // Stockage temporaire (expire après 15 min via un script ou manuellement)
        await db.collection("temp_verifications").doc(email).set({
            otp, clientName, date, time, phone, ip: userIp,
            createdAt: new Date()
        });

        const mailOptions = {
            from: '"YM Coiffure" <coiffureym63@outlook.com>',
            to: email,
            subject: `${otp} est votre code de confirmation YM`,
            html: `
                <div style="font-family: sans-serif; max-width: 400px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 15px;">
                    <h2 style="text-align: center;">YM COIFFURE</h2>
                    <p>Bonjour <b>${clientName}</b>,</p>
                    <p>Voici votre code pour valider votre rendez-vous du ${date.split('-').reverse().join('/')} à ${time} :</p>
                    <div style="background: #000; color: #fff; font-size: 32px; text-align: center; padding: 10px; letter-spacing: 10px; border-radius: 8px;">
                        ${otp}
                    </div>
                    <p style="font-size: 12px; color: #888; text-align: center; margin-top: 20px;">Ce code expire dans 15 minutes.</p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        res.json({ success: true, message: "Code envoyé" });
    } catch (error) {
        console.error("Erreur Mail:", error);
        res.status(500).json({ error: "Erreur lors de l'envoi du mail" });
    }
});

// ÉTAPE 2 : Confirmer le code et enregistrer le RDV
app.post("/api/verify-confirm", async (req, res) => {
    const { email, code } = req.body;

    try {
        const verifyDoc = await db.collection("temp_verifications").doc(email).get();
        if (!verifyDoc.exists || verifyDoc.data().otp !== code) {
            return res.status(400).json({ error: "Code invalide ou expiré" });
        }

        const data = verifyDoc.data();

        // 1. Ajouter à Google Calendar
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

        // 2. Enregistrer définitivement dans Firestore
        await db.collection("appointments").add({
            date: data.date,
            time: data.time,
            clientName: data.clientName,
            phone: data.phone,
            email: email,
            calendarEventId: googleEvent.data.id,
            createdAt: new Date()
        });

        // 3. Supprimer la vérification temporaire
        await db.collection("temp_verifications").doc(email).delete();

        res.json({ success: true, message: "Rendez-vous confirmé !" });
    } catch (error) {
        console.error("Erreur Confirmation:", error);
        res.status(500).json({ error: "Erreur lors de la validation" });
    }
});

// =======================================================
// 3. ROUTES PUBLIQUES & ADMIN
// =======================================================

app.get("/api/status", async (req, res) => {
    const doc = await db.collection("settings").doc("status").get();
    res.json({ is_open: doc.exists ? doc.data().is_open : true });
});

app.get("/api/busy-slots", async (req, res) => {
    const { date } = req.query;
    const snapshot = await db.collection("appointments").where("date", "==", date).get();
    res.json({ busySlots: snapshot.docs.map(doc => doc.data().time) });
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
            await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: doc.data().calendarEventId }).catch(() => {});
        }
        await db.collection("appointments").doc(req.params.id).delete();
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: "Erreur" }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur YM sur port ${PORT}`));