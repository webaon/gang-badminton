'use client';

import { actionError } from '@/lib/i18n/error-text';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';

import { GANG_ROLES, type GangRole } from '@/domain/permissions/types';
import { addMemberByEmail, changeMemberRole, removeMember } from '@/server/actions/members';
import { setMonthlyMembership } from '@/server/actions/membership';

const ROLE_LABELS: Record<GangRole, string> = {
  owner: 'เจ้าของก๊วน',
  admin: 'แอดมิน',
  member: 'สมาชิก',
};

const ROLE_OPTIONS = GANG_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] }));

export type MemberRow = {
  id: string;
  userId: string;
  displayName: string;
  role: GangRole;
  /** สมาชิกรายเดือน — ค่าสนามเป็น 0 ตอนปิดรอบ และถูกออกบิลรายเดือน [WO-2.5-C] */
  isMonthlyMember: boolean;
};

export function MembersPanel({
  gangId,
  members,
  canManage,
  currentUserId,
}: {
  gangId: string;
  members: MemberRow[];
  canManage: boolean;
  currentUserId?: string;
}) {
  const router = useRouter();
  const busy = useRef(false);
  const [email, setEmail] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'monthly'>('all');
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const query = search.trim().toLocaleLowerCase('th');
  const visibleMembers = members.filter(
    (member) =>
      member.displayName.toLocaleLowerCase('th').includes(query) &&
      (filter === 'all' || member.isMonthlyMember),
  );

  async function run(
    fn: () => Promise<{ success: boolean; error?: { code?: string; message: string } }>,
  ) {
    if (busy.current || !canManage) return false;
    busy.current = true;
    setPending(true);
    setError(null);
    setNotice(null);

    try {
      const result = await fn();
      if (!result.success) {
        setError(actionError(result.error));
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError(actionError(undefined));
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  async function onAdd(event: FormEvent) {
    event.preventDefault();
    const ok = await run(() => addMemberByEmail(gangId, email));
    if (ok) {
      setEmail('');
      setNotice('เพิ่มสมาชิกแล้ว');
    }
  }

  async function onRemove(memberId: string) {
    const ok = await run(() => removeMember(gangId, memberId));
    if (ok) {
      setRemoveId(null);
      setNotice('เอาสมาชิกออกแล้ว');
    }
  }

  return (
    <VStack gap={6}>
      <VStack gap={2}>
        <Heading level={2}>สมาชิก {members.length} คน</Heading>
        <Text color="secondary">
          {canManage ? 'จัดการบทบาทพื้นฐานและสมาชิกรายเดือน' : 'รายชื่อและบทบาทพื้นฐานของสมาชิกในก๊วน'}
        </Text>
      </VStack>

      {canManage ? (
        <form onSubmit={onAdd} noValidate>
          <HStack gap={3} vAlign="end" wrap="wrap">
            <VStack className="min-w-0 w-full sm:flex-1">
              <TextInput
                type="email"
                label="เพิ่มสมาชิกด้วยอีเมล"
                value={email}
                onChange={setEmail}
                description="ต้องเป็นอีเมลของคนที่สมัครสมาชิกไว้แล้ว"
                size="md"
                isDisabled={pending}
              />
            </VStack>
            <Button
              type="submit"
              variant="primary"
              size="md"
              label="เพิ่ม"
              isLoading={pending}
              isDisabled={pending || email.trim() === ''}
            />
          </HStack>
        </form>
      ) : null}

      {error ? <Banner status="error" title={error} /> : null}
      {notice ? <Banner status="success" title={notice} /> : null}

      <VStack gap={3}>
        <HStack gap={3} vAlign="end" wrap="wrap">
          <VStack className="min-w-0 w-full sm:flex-1">
            <TextInput
              label="ค้นหาชื่อสมาชิก"
              placeholder="พิมพ์ชื่อสมาชิก"
              value={search}
              onChange={setSearch}
              size="md"
            />
          </VStack>
          <HStack gap={2} role="group" aria-label="กรองสมาชิก">
            <Button
              label="ทั้งหมด"
              variant="secondary"
              size="md"
              aria-pressed={filter === 'all'}
              onClick={() => setFilter('all')}
            >
              <Text color="primary">{filter === 'all' ? '✓ ทั้งหมด' : 'ทั้งหมด'}</Text>
            </Button>
            <Button
              label="รายเดือน"
              variant="secondary"
              size="md"
              aria-pressed={filter === 'monthly'}
              onClick={() => setFilter('monthly')}
            >
              <Text color="primary">{filter === 'monthly' ? '✓ รายเดือน' : 'รายเดือน'}</Text>
            </Button>
          </HStack>
        </HStack>
        <Text size="sm" color="secondary" role="status">
          แสดง {visibleMembers.length} จาก {members.length} คน
        </Text>
      </VStack>

      <VStack as="ul" gap={0} aria-label="รายชื่อสมาชิก" className="m-0 list-none p-0">
        {visibleMembers.map((member) => (
          <VStack as="li" key={member.id} gap={3} paddingBlock={4} className="border-b border-border">
            <HStack gap={4} className="flex-col lg:flex-row lg:items-center">
              <VStack gap={1} className="min-w-0 flex-1">
                <Text weight="semibold" className="break-words">
                  {member.displayName}{member.userId === currentUserId ? ' (คุณ)' : ''}
                </Text>
                <Text size="sm" color="secondary">
                  {ROLE_LABELS[member.role]}
                  {member.isMonthlyMember ? ' · รายเดือน' : ''}
                </Text>
              </VStack>

              {canManage ? (
                <HStack gap={3} vAlign="center" wrap="wrap" className="lg:shrink-0">
                  {/* Enlarge both the native input and its associated label, not just the outer row. */}
                  <CheckboxInput
                    label="รายเดือน"
                    size="md"
                    className="min-w-32 [&_input]:min-h-11 [&_input]:min-w-11 [&_label]:flex [&_label]:min-h-11 [&_label]:min-w-11 [&_label]:items-center [&>div>div:first-child]:min-h-11 [&>div>div:first-child]:min-w-11"
                    value={member.isMonthlyMember}
                    isDisabled={pending}
                    onChange={(next) => run(() => setMonthlyMembership(gangId, member.id, next))}
                  />
                  <VStack className="w-40">
                    <Selector
                      label="บทบาท"
                      isLabelHidden
                      size="md"
                      options={ROLE_OPTIONS}
                      value={member.role}
                      isDisabled={pending}
                      onChange={(role) => run(() => changeMemberRole(gangId, member.id, role as GangRole))}
                    />
                  </VStack>
                  <Button
                    variant="ghost"
                    size="md"
                    label="เอาออก"
                    isDisabled={pending}
                    aria-expanded={removeId === member.id}
                    aria-controls={`remove-member-${member.id}`}
                    onClick={() => setRemoveId(removeId === member.id ? null : member.id)}
                  />
                </HStack>
              ) : null}
            </HStack>

            {canManage && removeId === member.id ? (
              <VStack id={`remove-member-${member.id}`} gap={3} padding={4} className="bg-surface rounded-lg">
                <Text weight="semibold" className="break-words">
                  ยืนยันเอา {member.displayName} ออกจากก๊วน?
                </Text>
                <HStack gap={3} wrap="wrap">
                  <Button
                    label="ยกเลิก"
                    variant="secondary"
                    size="md"
                    isDisabled={pending}
                    onClick={() => setRemoveId(null)}
                  />
                  <Button
                    label="ยืนยันเอาออก"
                    variant="destructive"
                    size="md"
                    isLoading={pending}
                    isDisabled={pending}
                    onClick={() => onRemove(member.id)}
                  />
                </HStack>
              </VStack>
            ) : null}
          </VStack>
        ))}
      </VStack>

      {visibleMembers.length === 0 ? (
        <VStack gap={3} paddingBlock={6} hAlign="start">
          <Heading level={3}>{members.length === 0 ? 'ยังไม่มีสมาชิก' : 'ไม่พบสมาชิกที่ตรงกับตัวกรอง'}</Heading>
          {members.length > 0 ? (
            <Button
              label="ล้างตัวกรอง"
              variant="secondary"
              size="md"
              onClick={() => { setSearch(''); setFilter('all'); }}
            />
          ) : null}
        </VStack>
      ) : null}
    </VStack>
  );
}
