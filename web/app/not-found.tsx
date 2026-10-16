import Link from "next/link";

export default function NotFound() {
  return (
    <main className="blueprint grid min-h-dvh place-items-center px-4">
      <div className="grid max-w-lg gap-4 border border-line-hi bg-bg p-6">
        <p className="tl text-red"><span aria-hidden>▲ </span>Error 404 · No Such Record</p>
        <h1 className="macro text-5xl text-ink">Off the Trail</h1>
        <p className="font-sans text-[15px] text-ink-2">This link isn’t part of the investigation. It may be old or mistyped. Rings, alerts and accounts open from the console.</p>
        <Link href="/" className="tl justify-self-start bg-ink px-4 py-2.5 font-semibold text-bg transition-colors hover:bg-red">Back to the Console</Link>
      </div>
    </main>
  );
}
