import "dotenv/config";
import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import { google } from "googleapis";
import fs from "fs";
import * as Brevo from '@getbrevo/brevo'; // Remplacement de Nodemailer

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

// Configuration API Brevo (Beaucoup plus fiable que le SMTP sur Render)
const apiInstance = new Brevo.TransactionalEmailsApi();
apiInstance.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.MAIL_PASS);

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
        console.log(`✅ Nettoyage : ${snapshot.size} anciens RDV supprimés.`);
    } catch (error) {
        console.error("❌ Erreur nettoyage:", error);
    }
}
cleanupOldAppointments();

// =======================================================
// 3. LOGIQUE DE VÉRIFICATION PAR MAIL (OTP)
// =======================================================

// ÉTAPE 1 : Envoyer le code de validation via API BREVO
app.post("/api/verify-request", async (req, res) => {
    const { email, clientName, date, time, phone } = req.body;
    if (!email || !date || !time) return res.status(400).json({ error: "Données manquantes" });

    try {
        const otp = Math.floor(1000 + Math.random() * 9000).toString();
        
        // Stockage temporaire (expire après 15 min)
        await db.collection("temp_verifications").doc(email).set({
            otp, clientName, date, time, phone,
            createdAt: new Date()
        });

        // Envoi via l'API Brevo
        const sendSmtpEmail = new Brevo.SendSmtpEmail();
        sendSmtpEmail.subject = `Votre code de confirmation : ${otp}`;
        sendSmtpEmail.htmlContent = `
            <div style="font-family: sans-serif; text-align: center; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
                <h2>YM COIFFURE</h2>
                <p>Bonjour <b>${clientName}</b>,</p>
                <p>Voici votre code pour confirmer votre rendez-vous du ${date} à ${time} :</p>
                <h1 style="background: #000; color: #fff; padding: 10px; letter-spacing: 10px;">${otp}</h1>
                <p style="font-size: 12px; color: #888;">Ce code expire dans 15 minutes.</p>
            </div>`;
        sendSmtpEmail.sender = { "name": "YM Coiffure", "email": "coiffureym63@outlook.com" };
        sendSmtpEmail.to = [{ "email": email, "name": clientName }];

        await apiInstance.sendTransacEmail(sendSmtpEmail);
        
        console.log(`✅ Code OTP envoyé à ${email}`);
        return res.json({ success: true, message: "Code envoyé !" });

    } catch (error) {
        console.error("❌ Erreur API Brevo:", error);
        // Important : on renvoie une erreur pour débloquer le bouton sur le site
        return res.status(500).json({ error: "Impossible d'envoyer le mail. Vérifiez votre clé API Brevo." });
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