export const metadata = {
  title: 'Life Control',
  description: 'Centro de controle da vida',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Life Control' },
  icons: {
    icon: [{ url: '/icon?v=3', sizes: '192x192', type: 'image/png' }],
    apple: [{ url: '/apple-icon?v=3', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport = {
  themeColor: '#0B0B0F',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
        <style>{`
          * { box-sizing: border-box; }
          html, body { margin: 0; padding: 0; background: #0B0B0F; color: #ECECEF; font-family: 'Outfit', system-ui, -apple-system, sans-serif; }
          body { -webkit-font-smoothing: antialiased; overscroll-behavior-y: none; }
          input, textarea, select, button { font-family: inherit; }
          @keyframes lccPulse { 0%,100% { opacity: .35; transform: scale(0.97); } 50% { opacity: 1; transform: scale(1.03); } }
          .lcc-pulse { animation: lccPulse 1.4s ease-in-out infinite; }
        `}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
