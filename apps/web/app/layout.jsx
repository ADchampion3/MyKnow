export const metadata = {
  title: "MyKnow",
  description: "Personal knowledge workspace"
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
