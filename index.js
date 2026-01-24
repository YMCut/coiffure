import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import { google } from "googleapis";
import fs from "fs";


// =======================================================
// 1. CONFIGURATION ET INITIALISATION (AU DÉBUT)
// =======================================================

// --- CHARGEMENT DES CLÉS ---
// On essaie de lire la clé depuis les variables d'environnement (Render)
// Sinon, on lit le fichier local (Développement)
const SERVICE_ACCOUNT_KEY_CONTENT = JSON.parse(
    process.env.SERVICE_ACCOUNT_KEY || fs.readFileSync("./google-service-account.json", "utf8")
);

// --- FIREBASE INIT ---
admin.initializeApp({
    // IMPORTANT : Utiliser la variable qui contient le JSON PARSÉ
    credential: admin.credential.cert(SERVICE_ACCOUNT_KEY_CONTENT), 
});
const db = admin.firestore();

// --- GOOGLE CALENDAR AUTH ---
const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const auth = new google.auth.GoogleAuth({
    credentials: SERVICE_ACCOUNT_KEY_CONTENT, // Utiliser la variable PARSÉE pour l'auth Google
    scopes: SCOPES,
});
const calendar = google.calendar({ version: "v3", auth });

// --- EXPRESS APP INIT ---
const app = express();
app.use(cors());
app.use(express.json());


// =======================================================
// 2. TÂCHES DE MAINTENANCE (NETTOYAGE)
// =======================================================

async function cleanupOldAppointments() {
    console.log("Démarrage du nettoyage des anciens rendez-vous...");

    // 1. Calculer la date limite (il y a 7 jours)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const limitDateString = sevenDaysAgo.toISOString().split('T')[0]; 

    try {
        const snapshot = await db.collection("appointments")
            .where("date", "<=", limitDateString)
            .get();

        if (snapshot.empty) {
            console.log("Aucun ancien rendez-vous de plus d'une semaine trouvé.");
            return;
        }

        const batch = db.batch();
        snapshot.docs.forEach(doc => {
            batch.delete(doc.ref);
        });

        await batch.commit();
        console.log(`✅ Nettoyage terminé. ${snapshot.size} rendez-vous ont été supprimés de Firestore.`);
    } catch (error) {
        console.error("❌ Erreur lors de l'opération de nettoyage Firestore:", error);
    }
}

// Exécuter le nettoyage au démarrage du serveur Render
cleanupOldAppointments();


// =======================================================
// 3. ROUTES API
// =======================================================

// --- ROUTE 1: VÉRIFIER L'ÉTAT D'OUVERTURE ---
app.get("/api/status", async (req, res) => {
    try {
        const doc = await db.collection("settings").doc("status").get();

        if (!doc.exists) {
            // Document 'status' non trouvé, le salon est considéré comme OUVERT par défaut
            return res.json({ is_open: true }); 
        }

        return res.json({ is_open: doc.data().is_open });

    } catch (error) {
        console.error("Erreur lors de la récupération du statut:", error);
        // Erreur critique de la DB, on suppose que le système doit rester ouvert pour les réservations existantes.
        res.status(500).json({ is_open: true, error: "Erreur serveur" });
    }
});

// --- ROUTE POUR LE MONITORING (HEALTH CHECK) (NOUVEAU) ---
app.get("/health", (req, res) => {
    // Réponse rapide et simple pour garder le serveur actif
    res.status(200).send("OK");
});

// --- ROUTE 2: CRÉER UN RENDEZ-VOUS ---
app.post("/api/book", async (req, res) => {
    
    // --- VÉRIFICATION DE L'ÉTAT D'OUVERTURE ---
    try {
        const statusDoc = await db.collection("settings").doc("status").get();
        // Le serveur est bloqué si le document existe et is_open est FALSE
        const isOpen = statusDoc.exists ? statusDoc.data().is_open : true; 

        if (!isOpen) {
            return res.status(403).json({ error: "Le salon est actuellement fermé. Les réservations ne sont pas acceptées." });
        }
    } catch (statusError) {
        console.error("Erreur de vérification du statut:", statusError);
        // On continue la réservation en cas d'erreur sur la vérification du statut
    }
    // ----------------------------------------

    const { date, time, clientName, phone } = req.body; 

    // Vérification des données entrantes (duplication de la destructuring corrigée)
    if (!date || !time || !clientName || !phone) {
        return res.status(400).json({ error: "Données manquantes" });
    }

    try {
        // 1. Vérifier si le créneau est déjà pris (Firestore)
        const snapshot = await db
            .collection("appointments")
            .where("date", "==", date)
            .where("time", "==", time)
            .get();

        if (!snapshot.empty) {
            return res.status(400).json({ error: "Créneau déjà réservé" });
        }

        // 2. Calcul de l'heure de fin (30 minutes)
        const startTimeString = `${date}T${time}:00`;
        const startDate = new Date(startTimeString);
        
        if (isNaN(startDate)) {
            return res.status(400).json({ error: "Format de date ou d'heure invalide." });
        }
        
        const endDate = new Date(startDate.getTime() + 30 * 60000); // Ajout de 30 minutes
        const endTime = `${String(endDate.getHours()).padStart(2, "0")}:${String(endDate.getMinutes()).padStart(2, "0")}`;
        
        // 3. Enregistrer dans Firestore
        await db.collection("appointments").add({
            date,
            time,
            clientName,
            phone,
            status: "reserved",
            createdAt: new Date()
        });

        // 4. Ajouter dans Google Calendar
        const event = {
            summary: `RDV coiffure – ${clientName}`,
            description: `Téléphone : ${phone}`,
            start: {
                dateTime: `${date}T${time}:00`,
                timeZone: "Europe/Paris",
            },
            end: {
                dateTime: `${date}T${endTime}:00`, 
                timeZone: "Europe/Paris",
            },
        };

        await calendar.events.insert({
            calendarId: "rowan.blanc@gmail.com", // **À vérifier :** Mettez votre ID de calendrier ici
            requestBody: event,
        });
        // 2. Insertion sur le deuxième calendrier
        await calendar.events.insert({
            calendarId: "msallaky@gmail.com", // <-- Le second calendarId
            requestBody: event,
        });

        res.json({ success: true, message: "Rendez-vous enregistré !" });

    } catch (error) {
        console.error("Erreur de réservation:", error);
        res.status(500).json({ error: "Erreur serveur" });
    }
});


// =======================================================
// 4. DÉMARRAGE SERVEUR
// =======================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});




