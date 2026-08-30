export const metadata = {
  title: "MyKnow",
  description: "Personal knowledge workspace"
};

export const dynamic = "force-dynamic";

const runtimeApiUrl = () => process.env["NEXT_PUBLIC_API_URL"] || `http://127.0.0.1:${process.env.API_PORT || "3001"}`;

export default function RootLayout({ children }) {
  const apiUrl = runtimeApiUrl();
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body data-api-url={apiUrl}>{children}</body>
    </html>
  );
}
