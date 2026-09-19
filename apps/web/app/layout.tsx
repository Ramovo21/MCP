import './globals.css';
export const metadata = {
  title: 'OmniMCP — Integration & Action Gateway',
  description: 'Secure access to every tool, through one gateway.',
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
