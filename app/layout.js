import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

const SF_STACK = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', system-ui, sans-serif";

export const metadata = {
  title: 'Life Control',
  description: 'Centro de controle da vida',
  manifest: '/manifest.json',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Life Control' },
  icons: {
    icon: [{ url: '/icon.png', sizes: '192x192', type: 'image/png' }],
    apple: [{ url: '/apple-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport = {
  themeColor: '#0A0E17',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <head>
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossOrigin="" />
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossOrigin="" async></script>
        <style>{`
          * { box-sizing: border-box; }
          html, body { margin: 0; padding: 0; background: #0A0E17; color: #FFFFFF; font-family: ${SF_STACK}; }
          body { -webkit-font-smoothing: antialiased; overscroll-behavior-y: none; }
          input, textarea, select, button { font-family: inherit; color: inherit; }
          @keyframes lccPulse { 0%,100% { opacity: .35; transform: scale(0.97); } 50% { opacity: 1; transform: scale(1.03); } }
          .lcc-pulse { animation: lccPulse 1.4s ease-in-out infinite; }
          .lcc-tip { background: rgba(10,14,23,.85) !important; border: none !important; color: #F59E0B !important; font-size: 10px !important; font-weight: 700 !important; box-shadow: none !important; padding: 1px 5px !important; }
          .lcc-tip::before { display: none !important; }
          .leaflet-container { font-family: ${SF_STACK} !important; background: #0A0E17 !important; }
          .react-grid-placeholder { background: rgba(37,99,235,0.28) !important; border-radius: 16px !important; }
          .react-grid-item.react-grid-item-resizing { opacity: 0.9; }
          .react-resizable-handle { z-index: 5; }
        `}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
