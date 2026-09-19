import Console from '../../components/console';
export function generateStaticParams() {
  return [
    'dashboard',
    'connections',
    'tools',
    'mcp-servers',
    'approvals',
    'executions',
    'logs',
    'playground',
    'api-keys',
    'organization',
    'settings',
  ].map((section) => ({ section }));
}
export const dynamicParams = false;
export default function Page() {
  return <Console />;
}
