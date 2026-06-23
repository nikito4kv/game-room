import RoomClient from "./RoomClient";

// В Next.js 16 params — это Promise, поэтому страница асинхронная.
export default async function RoomPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return <RoomClient code={code.toUpperCase()} />;
}
