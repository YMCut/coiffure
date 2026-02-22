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
// 2. FONCTIONS DE MAINTENANCE (Nettoyage & Rappels)
// =======================================================

/**
 * Supprime les rendez-vous passés
 */
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

/**
 * Envoie un mail de rappel (Configuré ici pour test à 3min)
 */
async function sendReminders() {
    const now = new Date();
    
    // --- LOGIQUE POUR LE TEST : ON CIBLE DEMAIN ---
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1); // On ajoute +1 jour à la date actuelle

    const targetDay = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Paris",
        year: "numeric", month: "2-digit", day: "2-digit",
    }).format(tomorrow);

    console.log(`--- DÉBUT TEST RAPPEL DEMAIN ---`);
    console.log(`Date cible (Demain Paris) : [${targetDay}]`);

    try {
        // On cherche les RDV de demain qui n'ont pas encore reçu de rappel
        const snapshot = await db.collection("appointments")
            .where("date", "==", targetDay)
            .where("reminderSent", "==", false)
            .get();

        if (snapshot.empty) {
            console.log(`❌ Aucun RDV trouvé pour demain (${targetDay}) avec reminderSent: false`);
            return;
        }

        console.log(`🔍 ${snapshot.size} rendez-vous trouvé(s) pour demain.`);

        for (const doc of snapshot.docs) {
            const data = doc.data();
            console.log(`🔔 Envoi du rappel à : ${data.clientName} pour son RDV de demain à ${data.time}`);

            const response = await fetch("https://api.brevo.com/v3/smtp/email", {
                method: "POST",
                headers: {
                    "accept": "application/json",
                    "api-key": process.env.MAIL_PASS,
                    "content-type": "application/json"
                },
                body: JSON.stringify({
                    sender: { name: "YM Coiffure", email: "coiffureym63@outlook.com" },
                    to: [{ email: data.email, name: data.clientName }],
                    subject: "🔔 Rappel : Votre rendez-vous de demain - YM Coiffure",
                    htmlContent: `
                        <div style="font-family:sans-serif;padding:20px;border:1px solid #eee;border-radius:12px;text-align:center;">
                            <h2 style="color:#000;">À demain ! ✂️</h2>
                            <p>Bonjour <b>${data.clientName}</b>,</p>
                            <p>Petit rappel pour votre rendez-vous de demain à : <b>${data.time}</b></p>
                            <p>📍 58 rue Abbé Prévost, Clermont-Ferrand</p>
                            <p style="font-size:12px; color:#888;">Merci de prévenir en cas de retard.</p>
                        </div>`
                })
            });

            if (response.ok) {
                await doc.ref.update({ reminderSent: true });
                console.log(`✅ Rappel envoyé avec succès à ${data.email}`);
            } else {
                const err = await response.json();
                console.error("❌ Erreur Brevo :", err);
            }
        }
    } catch (error) {
        console.error("❌ Erreur technique :", error);
    }
}

// Lancement automatique (toutes les 30s pour ton test, à remettre à 3600000 plus tard)
setInterval(() => {
    sendReminders();
    cleanupOldAppointments();
}, 10000);

// =======================================================
// 3. ROUTES API (Vérification & Réservation)
// =======================================================

app.post("/api/verify-request", async (req, res) => {
    const { email, clientName, date, time, phone } = req.body;
    if (!email || !date || !time || !clientName || !phone) {
        return res.status(400).json({ success: false, error: "Données manquantes" });
    }

    try {
        const todayParis = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Europe/Paris",
            year: "numeric", month: "2-digit", day: "2-digit",
        }).format(new Date());

        const snapshot = await db.collection("appointments").where("email", "==", email).get();
        const existingRDV = snapshot.docs.find(doc => doc.data().date >= todayParis);

        if (existingRDV) {
            return res.json({ 
                success: false, 
                isDuplicate: true,
                message: "Vous avez déjà un rendez-vous actif."
            });
        }

        const otp = Math.floor(1000 + Math.random() * 9000).toString();
        await db.collection("temp_verifications").doc(email).set({
            otp, clientName, date, time, phone,
            createdAt: new Date()
        });

        await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: {
                "accept": "application/json",
                "api-key": process.env.MAIL_PASS,
                "content-type": "application/json"
            },
            body: JSON.stringify({
                sender: { name: "YM Coiffure", email: "coiffureym63@outlook.com" },
                to: [{ email, name: clientName }],
                subject: "Code de validation – YM Coiffure",
                htmlContent: `<div style="text-align:center;"><h2>Code : ${otp}</h2></div>`
            })
        });

        return res.json({ success: true });
    } catch (error) {
        return res.status(500).json({ success: false, error: "Erreur technique" });
    }
});

app.post("/api/verify-confirm", async (req, res) => {
    const { email, code } = req.body;
    try {
        const verifyDoc = await db.collection("temp_verifications").doc(email).get();
        if (!verifyDoc.exists || verifyDoc.data().otp !== code) {
            return res.status(400).json({ success: false, error: "Code invalide" });
        }

        const data = verifyDoc.data();
        const startISO = `${data.date}T${data.time}:00`;
        const endDate = new Date(new Date(startISO).getTime() + 30 * 60000);
        
        // 1. Google Calendar
        const googleEvent = await calendar.events.insert({
            calendarId: CALENDAR_ID,
            requestBody: {
                summary: `✂️ ${data.clientName}`,
                description: `Tel: ${data.phone}`,
                start: { dateTime: startISO, timeZone: "Europe/Paris" },
                end: { dateTime: endDate.toISOString().split('.')[0], timeZone: "Europe/Paris" },
            },
        });

        // 2. Firestore Définitif
        await db.collection("appointments").add({
            date: data.date, time: data.time, clientName: data.clientName,
            phone: data.phone, email: email, calendarEventId: googleEvent.data.id,
            reminderSent: false,
            createdAt: new Date()
        });

        // 3. ENVOI DU MAIL DE CONFIRMATION IMMÉDIAT
        await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: {
                "accept": "application/json",
                "api-key": process.env.MAIL_PASS,
                "content-type": "application/json"
            },
            body: JSON.stringify({
                sender: { name: "YM Coiffure", email: "coiffureym63@outlook.com" },
                to: [{ email, name: data.clientName }],
                subject: "✅ Rendez-vous confirmé – YM Coiffure",
                htmlContent: `
                    <div style="font-family:sans-serif;padding:20px;border:1px solid #eee;border-radius:12px;">
                        <h2>C'est validé !</h2>
                        <p>Rendez-vous le <b>${data.date}</b> à <b>${data.time}</b>.</p>
                        <p>📍 58 rue Abbé Prévost, 63100 Clermont-Ferrand</p>
                    </div>`
            })
        });

        await db.collection("temp_verifications").doc(email).delete();
        return res.json({ success: true });
    } catch (error) {
        return res.status(500).json({ success: false, error: "Erreur confirmation" });
    }
});

// =======================================================
// 4. ROUTES ADMIN & STATUT (Inchangées)
// =======================================================

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

const checkAuth = (req, res, next) => {
    if (req.headers['x-admin-key'] === ADMIN_KEY) return next();
    res.status(401).json({ error: "Refusé" });
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
    } catch (e) { res.status(500).json({ error: "Erreur" }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur YM actif sur le port ${PORT}`);
    sendReminders();
    cleanupOldAppointments();
});