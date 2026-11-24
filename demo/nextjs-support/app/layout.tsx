import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Waypoint Support',
  description: 'A support agent with Redis Agent Memory and the Vercel AI SDK',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
