import type { Metadata, Viewport } from "next";
import { Archivo_Black, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { API } from "./lib";
import "./globals.css";

const plexSans = IBM_Plex_Sans({ variable: "--font-plex-sans", subsets: ["latin"], weight: ["400", "500", "600"] });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500", "600"] });
const archivoBlack = Archivo_Black({ variable: "--font-archivo-black", subsets: ["latin"], weight: "400" });

const description = "Live AML investigation console. Groups alerts into mule rings, traces the money in time order and drafts the FIU-IND STR.";
export const metadata: Metadata = {
  title: "MuleTrace",
  description,
  applicationName: "MuleTrace",
  openGraph: { title: "MuleTrace", description, type: "website" },
  twitter: { card: "summary", title: "MuleTrace", description },
};
export const viewport: Viewport = { viewportFit: "cover", themeColor: "#f3f2ee", colorScheme: "light" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable} ${archivoBlack.variable} antialiased`}>
      <head><link rel="preconnect" href={API} crossOrigin="anonymous" /></head>
      <body>{children}</body>
    </html>
  );
}
