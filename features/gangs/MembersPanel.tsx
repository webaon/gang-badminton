'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Selector } from '@astryxdesign/core/Selector';
import { TextInput } from '@astryxdesign/core/TextInput';

import { GANG_ROLES, type GangRole } from '@/domain/permissions/types';
import { addMemberByEmail, changeMemberRole, removeMember } from '@/server/actions/members';

const ROLE_LABELS: Record<GangRole, string> = {
  owner: 'เจ้าของก๊วน',
  admin: 'แอดมิน',
  member: 'สมาชิก',
};

export type MemberRow = {
  id: string;
  userId: string;
  displayName: string;
  role: GangRole;
};

export function MembersPanel({
  gangId,
  members,
  canManage,
}: {
  gangId: string;
  members: MemberRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function run(fn: () => Promise<{ success: boolean; error?: { message: string } }>) {
    setPending(true);
    setError(null);
    setNotice(null);

    const result = await fn();

    if (result.success) {
      router.refresh();
    } else {
      setError(result.error?.message ?? 'ทำรายการไม่สำเร็จ');
    }
    setPending(false);
    return result.success;
  }

  async function onAdd(event: FormEvent) {
    event.preventDefault();
    const ok = await run(() => addMemberByEmail(gangId, email));
    if (ok) {
      setEmail('');
      setNotice('เพิ่มสมาชิกแล้ว');
    }
  }

  return (
    <div>
      {canManage ? (
        <form onSubmit={onAdd} noValidate className="mb-6">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <TextInput
                type="email"
                label="เพิ่มสมาชิกด้วยอีเมล"
                value={email}
                onChange={setEmail}
                description="ต้องเป็นอีเมลของคนที่สมัครสมาชิกไว้แล้ว"
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              label="เพิ่ม"
              isLoading={pending}
              isDisabled={email.trim() === ''}
            />
          </div>
        </form>
      ) : null}

      {error ? <Banner status="error" title={error} /> : null}
      {notice ? (
        <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice(null)} />
      ) : null}

      <ul className="mt-4 divide-y">
        {members.map((m) => (
          <li key={m.id} className="flex items-center justify-between gap-3 py-3">
            <span className="min-w-0 flex-1 truncate">{m.displayName}</span>

            {canManage ? (
              <>
                <div className="w-40">
                  <Selector
                    label="บทบาท"
                    isLabelHidden
                    size="sm"
                    options={GANG_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
                    value={m.role}
                    onChange={(role) => run(() => changeMemberRole(gangId, m.id, role as GangRole))}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  label="เอาออก"
                  isDisabled={pending}
                  onClick={() => run(() => removeMember(gangId, m.id))}
                />
              </>
            ) : (
              <span className="text-sm">{ROLE_LABELS[m.role]}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
