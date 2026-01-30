import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import { google } from "googleapis";
import fs from "fs";

// =======================================================
// 1. CONFIGURATION ET INITIALISATION
// =======================================================

const SERVICE_ACCOUNT_KEY_CONTENT = JSON.parse(
    process.env.SERVICE_ACCOUNT_KEY || fs.readFileSync("./google-service-account.json", "utf8")
);

admin.initializeApp({
    credential: admin.credential.cert(SERVICE_ACCOUNT_KEY_CONTENT), 
});
const db = admin.firestore();

const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const auth = new google.auth.GoogleAuth({
    credentials: SERVICE_ACCOUNT_KEY_CONTENT,
    scopes: SCOPES,
});
const calendar = google.calendar({ version: "v3", auth });

const app = express();
app.set('trust proxy', true); // Indispensable pour récupérer l'IP réelle sur Render
app.use(cors());
app.use(express.json());

const ADMIN_KEY = process.env.ADMIN_KEY || "Younesladinde";

// =======================================================
// 2. TÂCHES DE MAINTENANCE
// =======================================================

async function cleanupOldAppointments() {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const limitDateString = sevenDaysAgo.toISOString().split('T')[0]; 

    try {
        const snapshot = await db.collection("appointments")
            .where("date", "<=", limitDateString)
            .get();

        if (snapshot.empty) return;

        const batch = db.batch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        console.log(`✅ Nettoyage : ${snapshot.size} RDV supprimés.`);
    } catch (error) {
        console.error("❌ Erreur nettoyage:", error);
    }
}
cleanupOldAppointments();

// =======================================================
// 3. ROUTES PUBLIQUES
// =======================================================

app.get("/api/status", async (req, res) => {
    try {
        const doc = await db.collection("settings").doc("status").get();
        return res.json({ is_open: doc.exists ? doc.data().is_open : true });
    } catch (error) {
        res.status(500).json({ is_open: true });
    }
});

app.get("/api/busy-slots", async (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: "Date manquante" });
    try {
        const snapshot = await db.collection("appointments").where("date", "==", date).get();
        const busySlots = snapshot.docs.map(doc => doc.data().time);
        res.json({ busySlots });
    } catch (error) {
        res.status(500).json({ error: "Erreur" });
    }
});

// --- ROUTE RÉSERVATION (AVEC ANTI-SPAM IP ET SYNC GOOGLE) ---
app.post("/api/book", async (req, res) => {
    const userIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const { date, time, clientName, phone } = req.body;

    if (!date || !time || !clientName || !phone) {
        return res.status(400).json({ error: "Données manquantes" });
    }

    try {
        // 1. Vérifier si le salon est fermé
        const statusDoc = await db.collection("settings").doc("status").get();
        if (statusDoc.exists && !statusDoc.data().is_open) {
            return res.status(403).json({ error: "Salon fermé." });
        }

        // 2. ANTI-SPAM : 1 RDV max par 24h par IP
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const ipCheck = await db.collection("appointments")
            .where("ip", "==", userIp)
            .where("createdAt", ">", twentyFourHoursAgo)
            .get();

        if (!ipCheck.empty) {
            return res.status(429).json({ error: "Limite d'un rendez-vous par 24h atteinte." });
        }

        // 3. Vérifier disponibilité créneau
        const snapshot = await db.collection("appointments")
            .where("date", "==", date)
            .where("time", "==", time)
            .get();

        if (!snapshot.empty) return res.status(400).json({ error: "Déjà pris" });

        // 4. Calcul de l'heure de fin pour Google (+30 min)
        const startISO = `${date}T${time}:00`;
        const endDate = new Date(new Date(startISO).getTime() + 30 * 60000);
        const endISO = endDate.toISOString().split('.')[0]; // Format propre pour Google

        // 5. AJOUT GOOGLE CALENDAR
        const googleEvent = await calendar.events.insert({
            calendarId: "msallaky@gmail.com",
            requestBody: {
                summary: `✂️ ${clientName}`,
                description: `Tel: ${phone}\nIP: ${userIp}`,
                start: { dateTime: startISO, timeZone: "Europe/Paris" },
                end: { dateTime: `${date}T${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}:00`, timeZone: "Europe/Paris" },
            },
        });

        // 6. ENREGISTREMENT FIRESTORE (avec IP et ID Google)
        await db.collection("appointments").add({
            date,
            time,
            clientName,
            phone,
            ip: userIp,
            calendarEventId: googleEvent.data.id, // ID stocké pour suppression future
            createdAt: new Date()
        });

        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

// =======================================================
// 4. ROUTES ADMIN
// =======================================================

const checkAuth = (req, res, next) => {
    if (req.headers['x-admin-key'] === ADMIN_KEY) return next();
    res.status(401).json({ error: "Non autorisé" });
};

app.post("/api/admin/toggle-status", checkAuth, async (req, res) => {
    const { is_open } = req.body;
    await db.collection("settings").doc("status").set({ is_open });
    res.json({ success: true, is_open });
});

app.get("/api/admin/appointments", checkAuth, async (req, res) => {
    try {
        // Tri par date décroissante (plus récent en haut)
        const snapshot = await db.collection("appointments").orderBy("date", "desc").get();
        const list = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json(list);
    } catch (error) {
        res.status(500).json({ error: "Erreur" });
    }
});

// --- SUPPRESSION ADMIN (SYNC AVEC GOOGLE) ---
app.delete("/api/admin/appointment/:id", checkAuth, async (req, res) => {
    try {
        const doc = await db.collection("appointments").doc(req.params.id).get();
        if (!doc.exists) return res.status(404).json({ error: "Introuvable" });

        const data = doc.data();

        // Si on a l'ID Google, on le supprime de l'agenda aussi
        if (data.calendarEventId) {
            try {
                await calendar.events.delete({
                    calendarId: "msallaky@gmail.com",
                    eventId: data.calendarEventId,
                });
            } catch (err) { console.log("Déjà supprimé de Google"); }
        }

        await db.collection("appointments").doc(req.params.id).delete();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Erreur" });
    }
});

// =======================================================
// 5. DÉMARRAGE
// =======================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur actif sur le port ${PORT}`));