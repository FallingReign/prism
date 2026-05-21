import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Prism",
  description: "Prism hosted service and Prism website for local tools"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
