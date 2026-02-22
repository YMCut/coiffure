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
    // On récupère la date d'aujourd'hui au format YYYY-MM-DD
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
// Nettoyage au démarrage
cleanupOldAppointments();

// =======================================================
// 3. LOGIQUE DE VÉRIFICATION ET ENVOI OTP
// =======================================================

app.post("/api/verify-request", async (req, res) => {
    const { email, clientName, date, time, phone } = req.body;
    
    if (!email || !date || !time || !clientName || !phone) {
        return res.status(400).json({ success: false, error: "Données manquantes" });
    }

    try {
        // 1. VÉRIFICATION DOUBLON (Basée sur l'heure de Paris)
        const todayParis = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Europe/Paris",
            year: "numeric", month: "2-digit", day: "2-digit",
        }).format(new Date());

        const snapshot = await db.collection("appointments").where("email", "==", email).get();
        
        // On cherche si un RDV existe déjà aujourd'hui ou dans le futur
        const existingRDV = snapshot.docs.find(doc => doc.data().date >= todayParis);

        if (existingRDV) {
            const rdv = existingRDV.data();
            return res.json({ 
                success: false, 
                isDuplicate: true,
                message: `Vous avez déjà un rendez-vous prévu le ${rdv.date} à ${rdv.time}.`,
                suggestion: "Un seul rendez-vous actif est autorisé par client."
            });
        }

        // 2. GÉNÉRATION OTP (4 chiffres)
        const otp = Math.floor(1000 + Math.random() * 9000).toString();
        
        // Stockage temporaire (expire idéalement via un TTL Firestore ou nettoyage manuel)
        await db.collection("temp_verifications").doc(email).set({
            otp, clientName, date, time, phone,
            createdAt: new Date()
        });

        // 3. ENVOI VIA BREVO (FETCH API - Pas de lib externe nécessaire)
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
                    <div style="font-family: sans-serif; text-align: center; padding: 20px; border: 1px solid #ddd; border-radius: 10px; color: #333;">
                        <h2 style="margin-bottom: 20px;">YM COIFFURE</h2>
                        <p>Bonjour <b>${clientName}</b>,</p>
                        <p>Voici votre code pour confirmer votre rendez-vous du <b>${date}</b> à <b>${time}</b> :</p>
                        <div style="background: #000; color: #fff; padding: 15px; font-size: 24px; font-weight: bold; letter-spacing: 10px; display: inline-block; margin: 20px 0; border-radius: 5px;">
                            ${otp}
                        </div>
                        <p style="font-size: 12px; color: #888;">Ce code est valable pendant 15 minutes.</p>
                    </div>`
            })
        });

        if (!response.ok) {
            const errorDetails = await response.json();
            console.error("Détails erreur Brevo:", errorDetails);
            throw new Error("Erreur lors de l'envoi du mail via Brevo.");
        }

        console.log(`✅ Code OTP envoyé à ${email}`);
        return res.json({ success: true, message: "Code envoyé avec succès." });

    } catch (error) {
        console.error("❌ Erreur verify-request:", error.message);
        return res.status(500).json({ success: false, error: "Erreur technique lors de l'envoi du code." });
    }
});

// =======================================================
// 4. CONFIRMATION FINALE DU RDV
// =======================================================

app.post("/api/verify-confirm", async (req, res) => {
    const { email, code } = req.body;
    
    if (!email || !code) return res.status(400).json({ success: false, error: "Données manquantes" });

    try {
        const verifyDoc = await db.collection("temp_verifications").doc(email).get();
        
        if (!verifyDoc.exists || verifyDoc.data().otp !== code) {
            return res.status(400).json({ success: false, error: "Code invalide ou expiré." });
        }

        const data = verifyDoc.data();
        const startISO = `${data.date}T${data.time}:00`;
        const endDate = new Date(new Date(startISO).getTime() + 30 * 60000); // RDV de 30 min
        
        // 1. Ajout à Google Calendar
        const googleEvent = await calendar.events.insert({
            calendarId: CALENDAR_ID,
            requestBody: {
                summary: `✂️ ${data.clientName}`,
                description: `Tel: ${data.phone}\nMail: ${email}\n\n⚠️ Paiement espèces uniquement.`,
                start: { dateTime: startISO, timeZone: "Europe/Paris" },
                end: { dateTime: endDate.toISOString().split('.')[0], timeZone: "Europe/Paris" },
            },
        });

        // 2. Sauvegarde définitive dans Firestore
        await db.collection("appointments").add({
            date: data.date, 
            time: data.time, 
            clientName: data.clientName,
            phone: data.phone, 
            email: email, 
            calendarEventId: googleEvent.data.id,
            createdAt: new Date()
        });
        
        // 📧 Mail de confirmation du rendez-vous
        const confirmationResponse = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
            accept: "application/json",
            "api-key": process.env.MAIL_PASS,
            "content-type": "application/json"
        },
        body: JSON.stringify({
            sender: { name: "YM Coiffure", email: "coiffureym63@outlook.com" },
            to: [{ email, name: data.clientName }],
            subject: "✅ Rendez-vous confirmé – YM Coiffure",
            htmlContent: `
            <div style="font-family:sans-serif;padding:20px;max-width:500px;margin:auto;border:1px solid #eee;border-radius:12px">
                <h2 style="text-align:center;margin-bottom:20px">✂️ YM COIFFURE</h2>

                <p>Bonjour <b>${data.clientName}</b>,</p>

                <p>
                Votre rendez-vous est <b>confirmé</b> :
                </p>

                <ul style="list-style:none;padding:0;font-size:15px">
                <li>📅 <b>Date :</b> ${data.date}</li>
                <li>⏰ <b>Heure :</b> ${data.time}</li>
                <li>📍 <b>Adresse :</b><br>
                    58 rue Abbé Prévost<br>
                    63100 Clermont-Ferrand
                </li>
                </ul>

                <p style="margin-top:20px;text-align:center">
                👉 <a href="https://maps.app.goo.gl/THwG1wEeNPDKNmep9"
                    style="background:#000;color:#fff;padding:10px 16px;
                            border-radius:8px;text-decoration:none;font-weight:bold"
                    target="_blank">
                    Voir sur Google Maps
                </a>
                </p>

                <p style="margin-top:30px;font-size:13px;color:#666;text-align:center">
                Merci de vous présenter à l’heure.<br>
                À très bientôt ✂️
                </p>
            </div>
            `
        })
        });
        // 3. Suppression de la vérification temporaire
        await db.collection("temp_verifications").doc(email).delete();
        
        return res.json({ success: true, message: "Rendez-vous confirmé !" });

    } catch (error) {
        console.error("❌ Erreur confirmation:", error);
        return res.status(500).json({ success: false, error: "Impossible de finaliser la réservation." });
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
    } catch (e) { res.status(500).json({ error: "Erreur lors de la récupération des créneaux." }); }
});

// Middleware de sécurité Admin
const checkAuth = (req, res, next) => {
    if (req.headers['x-admin-key'] === ADMIN_KEY) return next();
    res.status(401).json({ error: "Accès refusé." });
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
            // Suppression synchro avec Google Calendar
            await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: doc.data().calendarEventId }).catch(()=>{});
        }
        await db.collection("appointments").doc(req.params.id).delete();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Erreur lors de la suppression." }); }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => console.log(`🚀 Serveur YM opérationnel sur le port ${PORT}`));
