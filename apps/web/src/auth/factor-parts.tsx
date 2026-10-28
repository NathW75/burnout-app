/**
 * Pieces shared by sign-up's authenticator steps and the account screens
 * that replace it or renew backup codes (PRD-007 §6.1.1, §6.7).
 */
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

/** "JBSW Y3DP EHPK 3PXP": the secret in groups of four, for typing by hand. */
export const groupSecret = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();

/** The QR code and the manual key. The only image the app ever shows (NIL). */
export function AuthenticatorQr({ secret, otpauthUrl }: { secret: string; otpauthUrl: string }) {
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220, color: { dark: '#0D0E0F', light: '#EDEFEA' } })
      .then((url) => live && setQr(url))
      .catch(() => live && setQr(null));
    return () => {
      live = false;
    };
  }, [otpauthUrl]);
  return (
    <div className="flex flex-col items-center gap-3 rounded-sm border border-rule bg-paper p-4">
      {qr ? <img src={qr} width={220} height={220} alt="QR code for your authenticator app" className="rounded-sm" /> : <div className="size-[220px]" />}
      <div className="flex flex-col items-center gap-1 text-center">
        <span className="font-mono text-[11px] tracking-[1px] text-muted">CAN’T SCAN? ENTER THIS KEY</span>
        <code className="font-mono text-[15px] tracking-[1px] break-words text-type">{groupSecret(secret)}</code>
      </div>
    </div>
  );
}

/** Ten one-time codes, shown once, with download and copy, and the "I've saved these" tick. */
export function BackupCodesPanel({ codes, email, saved, onSaved }: { codes: string[]; email: string | undefined; saved: boolean; onSaved: (v: boolean) => void }) {
  const download = () => {
    const text = `Burnout League backup codes for ${email ?? 'your account'}\nEach code works once.\n\n${codes.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'burnout-league-backup-codes.txt' });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <ul aria-label="Backup codes" className="m-0 grid list-none grid-cols-2 gap-2 rounded-sm border border-rule bg-paper p-4 font-mono text-[16px] tnum">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <button type="button" className="btn-outline flex-1" onClick={download}>DOWNLOAD .TXT</button>
        <button type="button" className="btn-outline flex-1" onClick={() => void navigator.clipboard?.writeText(codes.join('\n'))}>COPY</button>
      </div>
      <label className={`flex cursor-pointer items-start gap-[14px] rounded-sm border bg-paper p-[14px] ${saved ? 'border-accent' : 'border-rule'}`}>
        <input type="checkbox" checked={saved} onChange={(e) => onSaved(e.target.checked)} className="m-0 size-6 flex-none accent-accent" />
        <span className="text-[14px] leading-[1.5]">I’ve saved these codes.</span>
      </label>
    </>
  );
}
