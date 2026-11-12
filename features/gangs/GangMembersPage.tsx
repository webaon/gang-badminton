import { Heading } from '@astryxdesign/core/Heading';
import { VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { loadGangMembers } from '@/server/gangs/members-loader';
import { MembersPanel } from './MembersPanel';

export default async function GangMembersPage({ params }: { params: Promise<{ gangId: string }> }) {
  const { gangId } = await params;
  const data = await loadGangMembers(gangId);
  return (
    <VStack as="section" gap={5} padding={4} className="mx-auto w-full max-w-5xl">
      <Heading level={1}>สมาชิก · {data.name}</Heading>
      <Text color="secondary">รายชื่อ บทบาทพื้นฐาน และสถานะสมาชิกรายเดือน</Text>
      <MembersPanel gangId={gangId} members={data.members} canManage={data.canManage} />
    </VStack>
  );
}
