import { notFound } from "next/navigation";
import { TeacherDemo } from "@/components/pilot30-teacher-demo";
import { isPilot30TeacherDemoEnabled } from "@/server/pilot30-teacher-demo-access";

export const dynamic = "force-dynamic";

export default function Pilot30TeacherDemoPage() {
  if (!isPilot30TeacherDemoEnabled({
    NODE_ENV: process.env.NODE_ENV,
    PILOT30_TEACHER_DEMO_ENABLED: process.env.PILOT30_TEACHER_DEMO_ENABLED,
  })) notFound();

  return <TeacherDemo />;
}
