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
    const nowParis = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Paris" }));
    const todayParis = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    const currentTimeParis = nowParis.getHours().toString().padStart(2, '0') + ":" + nowParis.getMinutes().toString().padStart(2, '0');

    try {
        const snapshotOld = await db.collection("appointments").where("date", "<", todayParis).get();
        const snapshotToday = await db.collection("appointments").where("date", "==", todayParis).get();

        const batch = db.batch();
        let count = 0;

        snapshotOld.docs.forEach(doc => { batch.delete(doc.ref); count++; });
        snapshotToday.docs.forEach(doc => {
            if (doc.data().time <= currentTimeParis) { batch.delete(doc.ref); count++; }
        });

        if (count === 0) return;
        await batch.commit();
        console.log(`✅ Nettoyage : ${count} RDV supprimés.`);
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
                        sender: { name: "YM CUT", email: "coiffureym63@outlook.com" },
                        to: [{ email: data.email, name: data.clientName }],
                        subject: "🔔 Rappel : Votre rendez-vous de demain - YM Coiffure",
                        htmlContent: `
                            <div style="${emailTheme.wrapper}">
                                <div style="${emailTheme.container}">
                                    <div style="${emailTheme.header}"><h1 style="${emailTheme.h1}">YM CUT</h1></div>
                                    <div style="${emailTheme.body}">
                                        <h2 style="${emailTheme.h2}">À DEMAIN ! ✂️</h2>
                                        <p>Bonjour <b>${data.clientName}</b>,</p>
                                        <p>Petit rappel pour votre coupe prévue demain à :</p>
                                        <div style="font-size:36px; font-weight:bold; margin:20px 0;">${data.time}</div>
                                        <p style="color:#666;">📍Clermont-Ferrand</p>
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

setInterval(() => { sendReminders(); cleanupOldAppointments(); }, 300000);

// =======================================================
// 4. ROUTES API
// =======================================================

app.post("/api/verify-request", async (req, res) => {
    const { email, clientName, date, time, phone } = req.body;
    if (!email || !date || !time || !clientName || !phone) return res.status(400).json({ success: false });

    try {
        const blockedDoc = await db.collection("blacklist").doc(email).get();
        if (blockedDoc.exists) {
            return res.status(200).json({ 
                success: false, 
                message: "Les réservations sont indisponibles pour ce compte." 
            });
        }

        const checkEmail = await db.collection("appointments")
            .where("email", "==", email)
            .limit(1)
            .get();

        if (!checkEmail.empty) {
            return res.status(200).json({ 
                success: false, 
                message: "Vous avez déjà un rendez-vous réservé avec cet email." 
            });
        }

        const checkPhone = await db.collection("appointments")
            .where("phone", "==", phone)
            .limit(1)
            .get();

        if (!checkPhone.empty) {
            return res.status(200).json({ 
                success: false, 
                message: "Ce numéro de téléphone est déjà lié à un rendez-vous actif." 
            });
        }

        const existingSlot = await db.collection("appointments")
            .where("date", "==", date)
            .where("time", "==", time)
            .get();

        if (!existingSlot.empty) {
            return res.status(200).json({ 
                success: false, 
                message: "Désolé, ce créneau vient d'être réservé par quelqu'un d'autre." 
            });
        }

        const otp = Math.floor(1000 + Math.random() * 9000).toString();
        console.log(`[OTP] Généré pour ${email} : ${otp}`);

        await db.collection("temp_verifications").doc(email).set({ 
            otp, clientName, date, time, phone, createdAt: new Date() 
        });

        await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: { 
                "accept": "application/json", 
                "api-key": process.env.MAIL_PASS, 
                "content-type": "application/json" 
            },
            body: JSON.stringify({
                sender: { name: "YM CUT", email: "coiffureym63@outlook.com" },
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

    } catch (error) { 
        console.error("Erreur serveur détaillée:", error);
        res.status(500).json({ success: false, message: "Une erreur est survenue sur le serveur." }); 
    }
});

app.post("/api/verify-confirm", async (req, res) => {
    const { email, code } = req.body;
    console.log(`[OTP] Reçu pour ${email} : "${code}" (type: ${typeof code})`);
    try {
        const vDoc = await db.collection("temp_verifications").doc(email).get();
        if (!vDoc.exists) {
            console.log(`[OTP] Aucun document trouvé pour ${email}`);
            return res.status(400).json({ success: false });
        }
        const storedOtp = vDoc.data().otp;
        console.log(`[OTP] Stocké en base : "${storedOtp}" (type: ${typeof storedOtp})`);
        if (storedOtp !== code) {
            console.log(`[OTP] MISMATCH : "${storedOtp}" !== "${code}"`);
            return res.status(400).json({ success: false });
        }

        const data = vDoc.data();
        const startISO = `${data.date}T${data.time}:00`;
        const [h, m] = data.time.split(':').map(Number);
        const endH = String(m === 30 ? h + 1 : h).padStart(2, '0');
        const endM = m === 30 ? '00' : '30';
        const endISO = `${data.date}T${endH}:${endM}:00`;
        
        const gEvent = await calendar.events.insert({
            calendarId: CALENDAR_ID,
            requestBody: {
                summary: `✂️ ${data.clientName}`,
                description: `Tel: ${data.phone}`,
                start: { dateTime: startISO, timeZone: "Europe/Paris" },
                end: { dateTime: endISO, timeZone: "Europe/Paris" },
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
                to: [{ email, name: data.clientName }, { email: "wazyio48@gmail.com", name: "Confirmation" }],
                subject: "✅ Confirmation – YM Coiffure",
                htmlContent: `
                    <div style="${emailTheme.wrapper}">
                        <div style="${emailTheme.container}">
                            <div style="${emailTheme.header}"><h1 style="${emailTheme.h1}">YM CUT</h1></div>
                            <div style="${emailTheme.body}">
                                <h2 style="${emailTheme.h2}; color:#27ae60;">C'EST VALIDÉ !</h2>
                                <p>Rendez-vous confirmé pour <b>${data.clientName}</b>.</p>
                                <div style="background:#f9f9f9; padding:20px; border-radius:12px; margin:20px 0; text-align:left;">
                                    <p style="margin:5px 0;">📅 <b>Date :</b> ${data.date}</p>
                                    <p style="margin:5px 0;">🕒 <b>Heure :</b> ${data.time}</p>
                                    <p style="margin:5px 0;">📍 <b>Lieu :</b> Clermont-Ferrand</p>
                                    <p style="margin:5px 0;">👻 <b>Snap :</b> ym.cut</p>
                                </div>
                            </div>
                        </div>
                    </div>`
            })
        });

        await db.collection("temp_verifications").doc(email).delete();
        res.json({ success: true });
    } catch (error) { 
        console.error("Erreur verify-confirm:", error);
        res.status(500).json({ success: false }); 
    }
});

// --- ROUTES ADMIN ---

const checkAuth = (req, res, next) => {
    if (req.headers['x-admin-key'] === ADMIN_KEY) return next();
    res.status(401).json({ error: "Refusé" });
};

app.post("/api/appointments", checkAuth, async (req, res) => {
    const { clientName, date, time, timeEnd } = req.body;

    try {
        let current = new Date(`${date}T${time}:00`);
        const end = new Date(`${date}T${timeEnd}:00`);

        if (end <= current) {
            return res.status(400).json({ error: "L'heure de fin doit être après l'heure de début" });
        }

        const existingSnapshot = await db.collection("appointments")
            .where("date", "==", date)
            .get();
        
        const takenSlots = existingSnapshot.docs.map(doc => doc.data().time);

        const batch = db.batch();
        let count = 0;
        let skipped = 0;

        while (current < end) {
            const timeStr = current.toTimeString().substring(0, 5);
            
            if (!takenSlots.includes(timeStr)) {
                const docRef = db.collection("appointments").doc(); 
                batch.set(docRef, {
                    clientName: clientName || "⛔ INDISPONIBLE",
                    date: date,
                    time: timeStr,
                    email: "admin@ym.fr",
                    phone: "0000000000",
                    reminderSent: true,
                    isBlock: true,
                    createdAt: new Date()
                });
                count++;
            } else {
                skipped++;
            }

            current.setMinutes(current.getMinutes() + 30);
        }

        if (count > 0) {
            await batch.commit();
        }

        res.json({ 
            success: true, 
            message: `${count} créneaux bloqués.`,
            skipped: skipped
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

// Bloquer une période entière (horaires automatiques selon le jour)
app.post("/api/admin/block-period", checkAuth, async (req, res) => {
    const { dateStart, dateEnd } = req.body;
    if (!dateStart || !dateEnd) return res.status(400).json({ error: "Dates manquantes" });

    try {
        const [sy, sm, sd] = dateStart.split('-').map(Number);
        const [ey, em, ed] = dateEnd.split('-').map(Number);
        const start = new Date(sy, sm - 1, sd);
        const end = new Date(ey, em - 1, ed);
        if (end < start) return res.status(400).json({ error: "Date de fin avant date de début" });

        let totalBlocked = 0;
        let totalSkipped = 0;
        const current = new Date(start);

        while (current <= end) {
            const day = current.getDay();
            // Dimanche → on skip
            if (day !== 0) {
                const dateStr = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(current);
                const hStart = day === 6 ? 10 : 14; // Samedi 10h, semaine 14h
                const hEnd   = day === 6 ? 18 : 19; // Samedi 18h, semaine 19h

                const existingSnap = await db.collection("appointments").where("date", "==", dateStr).get();
                const takenSlots = existingSnap.docs.map(d => d.data().time);

                const batch = db.batch();
                let count = 0;
                for (let h = hStart; h < hEnd; h++) {
                    for (const m of ["00", "30"]) {
                        const timeStr = `${String(h).padStart(2,'0')}:${m}`;
                        if (!takenSlots.includes(timeStr)) {
                            const ref = db.collection("appointments").doc();
                            batch.set(ref, {
                                clientName: "⛔ INDISPONIBLE", date: dateStr, time: timeStr,
                                email: "admin@ym.fr", phone: "0000000000",
                                reminderSent: true, isBlock: true, createdAt: new Date()
                            });
                            count++;
                        } else { totalSkipped++; }
                    }
                }
                if (count > 0) await batch.commit();
                totalBlocked += count;
            }
            current.setDate(current.getDate() + 1);
        }

        res.json({ success: true, message: `${totalBlocked} créneaux bloqués, ${totalSkipped} déjà pris.` });

        // Stocker la période dans closed_periods pour pouvoir la rouvrir
        await db.collection("closed_periods").add({
            dateStart, dateEnd, blockedAt: new Date()
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

// Rouvrir un jour : supprime uniquement les blocs admin (isBlock: true)
app.delete("/api/admin/unblock-day", checkAuth, async (req, res) => {
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: "Date manquante" });

    try {
        const snapshot = await db.collection("appointments")
            .where("date", "==", date)
            .where("isBlock", "==", true)
            .get();

        if (snapshot.empty) return res.json({ success: true, message: "Aucun bloc à supprimer." });

        const batch = db.batch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        res.json({ success: true, message: `${snapshot.size} blocs supprimés.` });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

// Ouvrir un dimanche (horaires fixes 10h-18h)
app.post("/api/admin/open-sunday", checkAuth, async (req, res) => {
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: "Date manquante" });

    const [y, m, d] = date.split('-').map(Number);
    if (new Date(y, m - 1, d).getDay() !== 0) {
        return res.status(400).json({ error: "Ce n'est pas un dimanche." });
    }

    try {
        const existingSnap = await db.collection("appointments").where("date", "==", date).get();
        const takenSlots = existingSnap.docs.map(doc => doc.data().time);

        const batch = db.batch();
        let count = 0;
        // On bloque tout SAUF les créneaux 10h-18h → en fait on ne fait rien,
        // un dimanche ouvert = pas de blocs, les créneaux 10h-18h sont libres par défaut.
        // Donc on supprime les éventuels blocs admin existants sur ce dimanche.
        existingSnap.docs.forEach(doc => {
            if (doc.data().isBlock) { batch.delete(doc.ref); count++; }
        });
        if (count > 0) await batch.commit();

        res.json({ success: true, message: `Dimanche ouvert. ${count} blocs supprimés.` });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

app.get("/api/admin/appointments", checkAuth, async (req, res) => {
    try {
        const snapshot = await db.collection("appointments").orderBy("date", "desc").get();
        res.json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (e) { res.status(500).json({ error: "Erreur lecture" }); }
});

app.get("/api/admin/blacklist", checkAuth, async (req, res) => {
    try {
        const snapshot = await db.collection("blacklist").get();
        res.json(snapshot.docs.map(doc => ({ email: doc.id, ...doc.data() })));
    } catch (e) { res.status(500).json({ error: "Erreur lecture blacklist" }); }
});

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

// Lister les périodes fermées
app.get("/api/admin/closed-periods", checkAuth, async (req, res) => {
    try {
        const snapshot = await db.collection("closed_periods").orderBy("blockedAt", "desc").get();
        res.json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (e) { res.status(500).json({ error: "Erreur" }); }
});

// Rouvrir une période entière (supprime tous les blocs admin de chaque jour)
app.delete("/api/admin/closed-periods/:id", checkAuth, async (req, res) => {
    try {
        const doc = await db.collection("closed_periods").doc(req.params.id).get();
        if (!doc.exists) return res.status(404).json({ error: "Période introuvable" });

        const { dateStart, dateEnd } = doc.data();
        const [sy, sm, sd] = dateStart.split('-').map(Number);
        const [ey, em, ed] = dateEnd.split('-').map(Number);
        const current = new Date(sy, sm - 1, sd);
        const end = new Date(ey, em - 1, ed);

        let totalDeleted = 0;
        while (current <= end) {
            const dateStr = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(current);
            const snap = await db.collection("appointments")
                .where("date", "==", dateStr)
                .where("isBlock", "==", true)
                .get();
            if (!snap.empty) {
                const batch = db.batch();
                snap.docs.forEach(d => batch.delete(d.ref));
                await batch.commit();
                totalDeleted += snap.size;
            }
            current.setDate(current.getDate() + 1);
        }

        await db.collection("closed_periods").doc(req.params.id).delete();
        res.json({ success: true, message: `Période rouverte, ${totalDeleted} blocs supprimés.` });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

// Ouvrir un jour fermé manuellement (ex: dimanche)
app.post("/api/admin/open-day", checkAuth, async (req, res) => {
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: "Date manquante" });
    try {
        await db.collection("open_days").doc(date).set({ openedAt: new Date() });
        res.json({ success: true, message: `${date} marqué comme ouvert.` });
    } catch (e) { res.status(500).json({ error: "Erreur serveur" }); }
});

// Refermer un jour ouvert manuellement
app.delete("/api/admin/open-day/:date", checkAuth, async (req, res) => {
    try {
        await db.collection("open_days").doc(req.params.date).delete();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Erreur serveur" }); }
});

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

// Vérifier si une date est ouverte manuellement
app.get("/api/open-days", async (req, res) => {
    try {
        const snapshot = await db.collection("open_days").get();
        res.json({ dates: snapshot.docs.map(doc => doc.id) });
    } catch (e) { res.json({ dates: [] }); }
});

app.get('/', (req, res) => {
  res.send('Serveur actif et opérationnel !');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur YM actif sur le port ${PORT}`);
    sendReminders();
    cleanupOldAppointments();
});
