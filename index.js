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
// 2. STYLES DES EMAILS (DESIGN PREMIUM)
// =======================================================

const emailTheme = {
    wrapper: "font-family:'Helvetica Neue',Arial,sans-serif; width:100%; background-color:#f4f4f4; padding:20px 0;",
    container: "max-width:600px; margin:0 auto; background-color:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 15px rgba(0,0,0,0.05);",
    header: "background-color:#000000; padding:30px; text-align:center;",
    body: "padding:40px 30px; text-align:center; color:#333333;",
    h1: "color:#ffffff; margin:0; letter-spacing:4px; font-size:24px; text-transform:uppercase;",
    h2: "font-size:20px; margin-bottom:20px; color:#000;",
    otpBox: "background-color:#f8f8f8; border:2px dashed #000; border-radius:12px; padding:20px; margin:20px 0; font-size:32px; font-weight:bold; letter-spacing:8px;",
    button: "display:inline-block; padding:15px 30px; background-color:#000; color:#fff; text-decoration:none; border-radius:8px; font-weight:bold; margin-top:20px;",
    footer: "padding:20px; text-align:center; font-size:12px; color:#999;"
};

// =======================================================
// 3. FONCTIONS DE MAINTENANCE
// =======================================================

async function cleanupOldAppointments() {
    const todayParis = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());

    try {
        const snapshot = await db.collection("appointments").where("date", "<", todayParis).get();
        if (snapshot.empty) return;
        const batch = db.batch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        console.log(`✅ Nettoyage : ${snapshot.size} anciens RDV supprimés.`);
    } catch (error) { console.error("❌ Erreur nettoyage:", error); }
}

async function sendReminders() {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + (24 * 60 * 60 * 1000));
    const targetDay = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(tomorrow);
    
    const targetHour = tomorrow.getHours().toString().padStart(2, '0');
    const securityDelay = 60 * 60 * 1000; 

    try {
        const snapshot = await db.collection("appointments").where("date", "==", targetDay).where("reminderSent", "==", false).get();

        for (const doc of snapshot.docs) {
            const data = doc.data();
            if (data.time.startsWith(targetHour + ":")) {
                const createdAt = data.createdAt.toDate();
                if (now.getTime() - createdAt.getTime() < securityDelay) continue;

                await fetch("https://api.brevo.com/v3/smtp/email", {
                    method: "POST",
                    headers: { "accept": "application/json", "api-key": process.env.MAIL_PASS, "content-type": "application/json" },
                    body: JSON.stringify({
                        sender: { name: "YM Coiffure", email: "coiffureym63@outlook.com" },
                        to: [{ email: data.email, name: data.clientName }],
                        subject: "🔔 Rappel : Votre rendez-vous de demain - YM Coiffure",
                        htmlContent: `
                            <div style="${emailTheme.wrapper}">
                                <div style="${emailTheme.container}">
                                    <div style="${emailTheme.header}"><h1 style="${emailTheme.h1}">YM COIFFURE</h1></div>
                                    <div style="${emailTheme.body}">
                                        <h2 style="${emailTheme.h2}">À DEMAIN ! ✂️</h2>
                                        <p>Bonjour <b>${data.clientName}</b>,</p>
                                        <p>Petit rappel pour votre coupe prévue demain à :</p>
                                        <div style="font-size:36px; font-weight:bold; margin:20px 0;">${data.time}</div>
                                        <p style="color:#666;">📍 58 rue Abbé Prévost, Clermont-Ferrand</p>
                                    </div>
                                    <div style="${emailTheme.footer}">Merci de nous prévenir en cas d'annulation.</div>
                                </div>
                            </div>`
                    })
                });
                await doc.ref.update({ reminderSent: true });
            }
        }
    } catch (error) { console.error("❌ Erreur rappels:", error); }
}

setInterval(() => { sendReminders(); cleanupOldAppointments(); }, 1800000);

// =======================================================
// 4. ROUTES API
// =======================================================

app.post("/api/verify-request", async (req, res) => {
    const { email, clientName, date, time, phone } = req.body;
    if (!email || !date || !time || !clientName || !phone) return res.status(400).json({ success: false });

    try {
        // --- VÉRIFICATION BLACKLIST ---
        const blockedDoc = await db.collection("blacklist").doc(email).get();
        if (blockedDoc.exists) {
            return res.json({ 
                success: false, 
                message: "Les réservations sont indisponibles pour ce compte." 
            });
        }

        const otp = Math.floor(1000 + Math.random() * 9000).toString();
        await db.collection("temp_verifications").doc(email).set({ otp, clientName, date, time, phone, createdAt: new Date() });

        await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: { "accept": "application/json", "api-key": process.env.MAIL_PASS, "content-type": "application/json" },
            body: JSON.stringify({
                sender: { name: "YM Coiffure", email: "coiffureym63@outlook.com" },
                to: [{ email, name: clientName }],
                subject: "Code de validation – YM Coiffure",
                htmlContent: `
                    <div style="${emailTheme.wrapper}">
                        <div style="${emailTheme.container}">
                            <div style="${emailTheme.header}"><h1 style="${emailTheme.h1}">YM COIFFURE</h1></div>
                            <div style="${emailTheme.body}">
                                <h2 style="${emailTheme.h2}">VÉRIFICATION</h2>
                                <p>Bonjour ${clientName}, voici votre code pour confirmer votre rendez-vous :</p>
                                <div style="${emailTheme.otpBox}">${otp}</div>
                                <p style="font-size:13px; color:#999;">Ce code est valable 10 minutes.</p>
                            </div>
                        </div>
                    </div>`
            })
        });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post("/api/verify-confirm", async (req, res) => {
    const { email, code } = req.body;
    try {
        const vDoc = await db.collection("temp_verifications").doc(email).get();
        if (!vDoc.exists || vDoc.data().otp !== code) return res.status(400).json({ success: false });

        const data = vDoc.data();
        const startISO = `${data.date}T${data.time}:00`;
        const endDate = new Date(new Date(startISO).getTime() + 30 * 60000);
        
        const gEvent = await calendar.events.insert({
            calendarId: CALENDAR_ID,
            requestBody: {
                summary: `✂️ ${data.clientName}`,
                description: `Tel: ${data.phone}`,
                start: { dateTime: startISO, timeZone: "Europe/Paris" },
                end: { dateTime: endDate.toISOString().split('.')[0], timeZone: "Europe/Paris" },
            },
        });

        await db.collection("appointments").add({
            ...data, email: email, calendarEventId: gEvent.data.id, reminderSent: false, createdAt: new Date()
        });

        await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: { "accept": "application/json", "api-key": process.env.MAIL_PASS, "content-type": "application/json" },
            body: JSON.stringify({
                sender: { name: "YM Coiffure", email: "coiffureym63@outlook.com" },
                to: [{ email, name: data.clientName }],
                subject: "✅ Confirmation – YM Coiffure",
                htmlContent: `
                    <div style="${emailTheme.wrapper}">
                        <div style="${emailTheme.container}">
                            <div style="${emailTheme.header}"><h1 style="${emailTheme.h1}">YM COIFFURE</h1></div>
                            <div style="${emailTheme.body}">
                                <h2 style="${emailTheme.h2}; color:#27ae60;">C'EST VALIDÉ !</h2>
                                <p>Rendez-vous confirmé pour <b>${data.clientName}</b>.</p>
                                <div style="background:#f9f9f9; padding:20px; border-radius:12px; margin:20px 0; text-align:left;">
                                    <p style="margin:5px 0;">📅 <b>Date :</b> ${data.date}</p>
                                    <p style="margin:5px 0;">🕒 <b>Heure :</b> ${data.time}</p>
                                    <p style="margin:5px 0;">📍 <b>Lieu :</b> 58 rue Abbé Prévost, 63100 Clermont-Ferrand</p>
                                </div>
                                <a href="https://www.google.com/maps/search/?api=1&query=58+rue+Abbé+Prévost+Clermont-Ferrand" style="${emailTheme.button}">Ouvrir Maps</a>
                            </div>
                        </div>
                    </div>`
            })
        });

        await db.collection("temp_verifications").doc(email).delete();
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

// --- ROUTES ADMIN ---

const checkAuth = (req, res, next) => {
    if (req.headers['x-admin-key'] === ADMIN_KEY) return next();
    res.status(401).json({ error: "Refusé" });
};

app.get("/api/admin/appointments", checkAuth, async (req, res) => {
    try {
        const snapshot = await db.collection("appointments").orderBy("date", "desc").get();
        res.json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (e) { res.status(500).json({ error: "Erreur lecture" }); }
});

// LISTER LA BLACKLIST
app.get("/api/admin/blacklist", checkAuth, async (req, res) => {
    try {
        const snapshot = await db.collection("blacklist").get();
        res.json(snapshot.docs.map(doc => ({ email: doc.id, ...doc.data() })));
    } catch (e) { res.status(500).json({ error: "Erreur lecture blacklist" }); }
});

// BLOQUER UN EMAIL
app.post("/api/admin/block-email", checkAuth, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email manquant" });
    try {
        await db.collection("blacklist").doc(email).set({ 
            blockedAt: new Date(),
            reason: "Manuel"
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Erreur blacklist" }); }
});

// DÉBLOQUER UN EMAIL
app.delete("/api/admin/block-email/:email", checkAuth, async (req, res) => {
    try {
        await db.collection("blacklist").doc(req.params.email).delete();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Erreur suppression ban" }); }
});

app.delete("/api/admin/appointment/:id", checkAuth, async (req, res) => {
    try {
        const doc = await db.collection("appointments").doc(req.params.id).get();
        if (doc.exists && doc.data().calendarEventId) {
            await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: doc.data().calendarEventId }).catch(()=>{});
        }
        await db.collection("appointments").doc(req.params.id).delete();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Erreur" }); }
});

app.post("/api/admin/toggle-status", checkAuth, async (req, res) => {
    const { is_open } = req.body;
    await db.collection("settings").doc("status").set({ is_open });
    res.json({ success: true, is_open });
});

// --- ROUTES PUBLIQUES ---

app.get("/api/status", async (req, res) => {
    try {
        const doc = await db.collection("settings").doc("status").get();
        res.json({ is_open: doc.exists ? doc.data().is_open : true });
    } catch (e) { res.json({ is_open: true }); }
});

app.get("/api/busy-slots", async (req, res) => {
    const { date } = req.query;
    try {
        const snapshot = await db.collection("appointments").where("date", "==", date).get();
        res.json({ busySlots: snapshot.docs.map(doc => doc.data().time) });
    } catch (e) { res.status(500).json({ error: "Erreur" }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur YM actif sur le port ${PORT}`);
    sendReminders();
    cleanupOldAppointments();
});