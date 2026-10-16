// Voix naturelle du recruteur (Google Cloud Text-to-Speech, voix « Chirp 3 HD »).
// Optionnel : sans la clé GOOGLE_TTS_KEY, l'app utilise la voix du navigateur.
// Seul le texte produit par le serveur (questions du recruteur) est synthétisé : pas de synthèse « à la demande ».

const FEMALE = new Set(["Claire", "Sophie", "Emma", "Priya", "Anna", "Sarah", "Giulia", "Elena"]);
const LANG_CODE: Record<string, string> = { fr: "fr-FR", en: "en-GB", de: "de-DE", it: "it-IT" };
const PRICE_PER_CHAR = Number(Deno.env.get("PRICE_TTS_PER_MCHAR") ?? 30) / 1e6;

/** Voix stable pour un recruteur donné (même voix pendant tout l'entretien). */
export function voiceFor(persona: string, lang: string): { languageCode: string; name: string } {
  const first = persona.trim().split(/\s+/)[0] ?? "";
  const female = FEMALE.has(first);
  const pool = female ? ["Aoede", "Kore", "Leda"] : ["Charon", "Orus", "Fenrir"];
  let h = 0; for (const c of persona) h = (h * 31 + c.charCodeAt(0)) | 0;
  const code = LANG_CODE[lang] ?? "fr-FR";
  return { languageCode: code, name: `${code}-Chirp3-HD-${pool[Math.abs(h) % pool.length]}` };
}

/** Renvoie l'audio MP3 en base64 (ou null si la voix naturelle n'est pas configurée ou échoue) et son coût. */
export async function synthesize(text: string, persona: string, lang: string): Promise<{ audio: string | null; cost: number }> {
  const key = Deno.env.get("GOOGLE_TTS_KEY");
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 900);
  if (!key || !clean) return { audio: null, cost: 0 };
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`, {
      method: "POST", signal: ctl.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { text: clean }, voice: voiceFor(persona, lang), audioConfig: { audioEncoding: "MP3" } }),
    });
    if (!res.ok) { console.error("tts", res.status, (await res.text()).slice(0, 300)); return { audio: null, cost: 0 }; }
    const data = await res.json() as { audioContent?: string };
    return { audio: data.audioContent ?? null, cost: clean.length * PRICE_PER_CHAR };
  } catch (e) {
    console.error("tts_failed", String(e)); return { audio: null, cost: 0 };
  } finally { clearTimeout(t); }
}
