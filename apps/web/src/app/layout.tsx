import type { Metadata } from "next";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import "@ui-sdk/core/web.css";
import "./globals.css";
import { Providers } from "@/components/providers";
import { cn } from "@/lib/utils";

const sans = Inter({ variable: "--font-app-sans", subsets: ["latin"] });

const mono = IBM_Plex_Mono({
  weight: ["400", "500"],
  variable: "--font-app-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Juno",
  description: "Turn GitHub issues into reviewable changes.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("h-full", "antialiased", sans.variable, mono.variable, "font-sans")}
    >
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
