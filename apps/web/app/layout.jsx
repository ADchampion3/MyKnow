export const metadata = {
  title: "MyKnow",
  description: "Personal knowledge workspace"
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
