import type { ReactNode } from 'react';
export const metadata = {title: 'Kontroll', description: 'Auto24 listing dashboard'};
export default function RootLayout({children}: {children: ReactNode}) { return <html lang="et"><body>{children}</body></html>; }
