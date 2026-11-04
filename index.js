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
// 2. E-MAILS (THÈME MARRON / BLANC, comme le site)
// =======================================================

const MAIL = {
    brown: "#4e2a18", cream: "#efdac5", paper: "#f8f3ee", line: "#e6d9cc", muted: "#8a6e5c", page: "#f3ece4",
    serif: "Georgia, 'Times New Roman', serif",
    sans: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    script: "'Snell Roundhand', 'Brush Script MT', 'Segoe Script', cursive"
};

const escapeHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function formatDateFr(dateStr) {
    const [y, m, d] = String(dateStr).split("-").map(Number);
    return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
        .format(new Date(Date.UTC(y, m - 1, d)));
}

function emailLayout(innerHtml, footerHtml = "") {
    return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background-color:${MAIL.page};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${MAIL.page};">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px; background-color:#ffffff; border-radius:20px; overflow:hidden; border:1px solid ${MAIL.line};">
    <tr><td align="center" style="background-color:${MAIL.brown}; padding:38px 20px 32px;">
      <div style="font-family:${MAIL.serif}; font-size:46px; line-height:1; letter-spacing:12px; padding-left:12px; color:${MAIL.cream};">YM</div>
      <div style="font-family:${MAIL.script}; font-style:italic; font-size:28px; line-height:1.2; color:${MAIL.cream}; margin-top:4px; padding-left:34px;">cut</div>
    </td></tr>
    <tr><td align="center" style="padding:38px 30px 30px; font-family:${MAIL.sans}; font-size:16px; line-height:1.6; color:${MAIL.brown};">
      ${innerHtml}
    </td></tr>
    <tr><td align="center" style="background-color:${MAIL.paper}; border-top:1px solid ${MAIL.line}; padding:22px 30px; font-family:${MAIL.sans}; font-size:13px; line-height:1.6; color:${MAIL.muted};">
      ${footerHtml}
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

function detailRow(label, value) {
    return `<tr>
      <td style="padding:12px 0; border-bottom:1px solid ${MAIL.line}; font-size:14px; color:${MAIL.muted}; text-align:left;">${label}</td>
      <td style="padding:12px 0; border-bottom:1px solid ${MAIL.line}; font-weight:600; color:${MAIL.brown}; text-align:right;">${value}</td>
    </tr>`;
}

function otpEmail(name, otp) {
    return emailLayout(`
      <h1 style="margin:0 0 14px; font-family:${MAIL.serif}; font-size:30px; font-weight:normal; color:${MAIL.brown};">Votre code de validation</h1>
      <p style="margin:0 0 26px;">Bonjour ${escapeHtml(name)}, voici votre code pour confirmer votre rendez-vous.</p>
      <div style="display:inline-block; background-color:${MAIL.paper}; border:1px solid ${MAIL.line}; border-radius:14px; padding:18px 22px 18px 34px; font-family:${MAIL.serif}; font-size:40px; letter-spacing:12px; color:${MAIL.brown};">${otp}</div>
      <p style="margin:26px 0 0; font-size:14px; color:${MAIL.muted};">Ce code est valable 10 minutes.</p>`,
      `Vous n’êtes pas à l’origine de cette demande ? Ignorez simplement cet e-mail.`);
}

function confirmationEmail(data) {
    const service = escapeHtml(data.service || "Coupe classique");
    return emailLayout(`
      <h1 style="margin:0 0 14px; font-family:${MAIL.serif}; font-size:30px; font-weight:normal; color:${MAIL.brown};">Rendez-vous confirmé</h1>
      <p style="margin:0 0 26px;">Bonjour ${escapeHtml(data.clientName)}, votre rendez-vous est bien enregistré.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${MAIL.paper}; border:1px solid ${MAIL.line}; border-radius:16px;">
        <tr><td style="padding:6px 22px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:${MAIL.sans}; font-size:16px;">
            ${detailRow("Date", escapeHtml(formatDateFr(data.date)))}
            ${detailRow("Heure", escapeHtml(data.time))}
            ${detailRow("Prestation", service)}
            ${detailRow("Lieu", "Clermont-Ferrand")}
          </table>
        </td></tr>
      </table>
      <p style="margin:24px 0 6px; font-size:15px;">Paiement en espèces uniquement.</p>
      <p style="margin:0; font-size:15px; color:${MAIL.muted};">Snapchat <b style="color:${MAIL.brown};">ym.cut</b> &nbsp;·&nbsp; Instagram <a href="https://www.instagram.com/ym._ct/" style="color:${MAIL.brown}; font-weight:bold;">ym._ct</a></p>`,
      `Un empêchement ? Prévenez-nous au moins 24 h à l’avance : un rendez-vous non annulé bloque vos prochaines réservations.`);
}

function reminderEmail(data) {
    return emailLayout(`
      <h1 style="margin:0 0 14px; font-family:${MAIL.serif}; font-size:30px; font-weight:normal; color:${MAIL.brown};">À demain !</h1>
      <p style="margin:0 0 20px;">Bonjour ${escapeHtml(data.clientName)}, petit rappel pour votre rendez-vous de demain à&nbsp;:</p>
      <div style="display:inline-block; background-color:${MAIL.paper}; border:1px solid ${MAIL.line}; border-radius:14px; padding:14px 34px; font-family:${MAIL.serif}; font-size:44px; line-height:1.1; color:${MAIL.brown};">${escapeHtml(data.time)}</div>
      <p style="margin:22px 0 4px; font-size:15px;">${escapeHtml(data.service || "Coupe classique")}</p>
      <p style="margin:0; font-size:15px; color:${MAIL.muted};">Clermont-Ferrand</p>`,
      `Un empêchement ? Merci de nous prévenir dès que possible.<br>Snapchat <b style="color:${MAIL.brown};">ym.cut</b> &nbsp;·&nbsp; Instagram <a href="https://www.instagram.com/ym._ct/" style="color:${MAIL.brown}; font-weight:bold;">ym._ct</a>`);
}

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
                        sender: { name: "YM cut", email: "coiffureym63@outlook.com" },
                        to: [{ email: data.email, name: data.clientName }],
                        subject: "Rappel : votre rendez-vous de demain – YM cut",
                        htmlContent: reminderEmail(data)
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
    const { email, clientName, date, time, phone, shampoing } = req.body;
    if (!email || !date || !time || !clientName || !phone) return res.status(400).json({ success: false });
    // Coupe classique, avec shampoing en option (sans prix enregistré)
    const service = (shampoing === true || shampoing === "true") ? "Coupe classique + shampoing" : "Coupe classique";
    console.log(`[RDV] shampoing reçu : ${shampoing} -> ${service}`);

    try {
        // Dimanche / lundi : réservable uniquement si le jour a été ouvert manuellement
        const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
        if (dow === 0 || dow === 1) {
            const openDoc = await db.collection("open_days").doc(date).get();
            if (!openDoc.exists) {
                return res.status(200).json({ success: false, message: "Le salon est fermé ce jour-là." });
            }
        }

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
            otp, clientName, date, time, phone, service, createdAt: new Date() 
        });

        await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: { 
                "accept": "application/json", 
                "api-key": process.env.MAIL_PASS, 
                "content-type": "application/json" 
            },
            body: JSON.stringify({
                sender: { name: "YM cut", email: "coiffureym63@outlook.com" },
                to: [{ email, name: clientName }],
                subject: "Votre code de validation – YM cut",
                htmlContent: otpEmail(clientName, otp)
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
                summary: `✂️ ${data.clientName} – ${data.service || "Coupe classique"}`,
                description: `Tel: ${data.phone}\nPrestation: ${data.service || "Coupe classique"}`,
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
                sender: { name: "YM cut", email: "coiffureym63@outlook.com" },
                to: [{ email, name: data.clientName }, { email: "coiffureym63send@outlook.fr", name: "Confirmation" }],
                subject: "Confirmation de votre rendez-vous – YM cut",
                htmlContent: confirmationEmail(data)
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
            if (day !== 0 && day !==1) {
                const dateStr = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(current);
                const hStart = day === 6 ? 14 : 14; // Samedi 14h, semaine 14h
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

        // Stocker la période dans closed_periods pour pouvoir la rouvrir (avant de répondre)
        await db.collection("closed_periods").add({
            dateStart, dateEnd, blockedAt: new Date()
        });

        res.json({ success: true, message: `${totalBlocked} créneaux bloqués, ${totalSkipped} déjà pris.` });

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
