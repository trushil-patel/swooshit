'use client';

import { Check, Copy, Fingerprint, Radio } from 'lucide-react';
import { useEffect, useState } from 'react';

type Identity = { code: string; token: string };
const storageKey = 'swooshit-trusted-device-v1';

function createIdentity(): Identity {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = `DL-${Array.from({ length: 8 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')}`;
  return { code, token: crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '') };
}

export default function TrustedDevicePanel() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { const saved = localStorage.getItem(storageKey); const value = saved ? JSON.parse(saved) as Identity : createIdentity(); if (!saved) localStorage.setItem(storageKey, JSON.stringify(value)); setIdentity(value); }, []);
  if (!identity) return null;
  const link = `${window.location.origin}?to=${identity.code}&token=${identity.token}`;
  return <section className="dev-console mb-6 rounded-[28px] p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="flex items-center gap-2 font-mono text-xs uppercase tracking-[.2em] text-cyan-300"><Fingerprint size={15}/> Trusted device</p><h2 className="mt-2 text-xl font-semibold">{identity.code}</h2><p className="mt-2 max-w-xl text-sm text-slate-400">This browser keeps its device code and secret link locally. Keep this tab open when you want automatic incoming transfers.</p></div><span className="flex items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-400/10 px-3 py-2 font-mono text-xs text-emerald-200"><Radio size={14}/> READY_TO_REGISTER</span></div><div className="mt-4 flex flex-wrap gap-2"><button onClick={() => { navigator.clipboard.writeText(link); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }} className="rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-semibold text-slate-950">{copied ? <><Check className="mr-2 inline" size={16}/>Trusted link copied</> : <><Copy className="mr-2 inline" size={16}/>Copy trusted link</>}</button><button onClick={() => { const next = createIdentity(); localStorage.setItem(storageKey, JSON.stringify(next)); setIdentity(next); }} className="rounded-xl border border-white/15 px-4 py-2.5 text-sm text-slate-300">Regenerate device key</button></div></section>;
}
