'use client';

import { useRef, useState, type ComponentProps } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button as AstryxButton } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { baht, isZeroAmount } from '@/domain/sessions/close-view';
import { utcToZonedWallClock } from '@/domain/time/timezone';
import { actionError } from '@/lib/i18n/error-text';
import {
  getMemberCredit, listGangCredits, payOutCredit, topUpCredit,
  type CreditEntry, type GangCreditSummary, type MemberCredit,
} from '@/server/actions/credit';

// Keep primary on-primary text; secondary/ghost labels use the readable Text token.
function Button(props: ComponentProps<typeof AstryxButton>) {
  if (props.variant === 'primary') return <AstryxButton {...props} />;
  return <AstryxButton {...props}><Text weight="semibold">{props.label}</Text></AstryxButton>;
}

type Member = GangCreditSummary['members'][number];
type Movement = 'topup' | 'payout';
const ENTRY_LABEL: Record<CreditEntry['type'], string> = {
  overpayment: 'โอนเกินเข้าเครดิต', applied: 'ใช้เครดิตชำระหนี้',
  admin_topup: 'เติมเครดิต', cash_payout: 'จ่ายคืนเงินสด', charge_return: 'คืนจากรายการหนี้เข้าเครดิต',
};

export function CreditWallet({ gangId, currentUserId, initial, canTopUp, canPayOut }: {
  gangId: string;
  currentUserId: string;
  initial: GangCreditSummary;
  canTopUp: boolean;
  canPayOut: boolean;
}) {
  const [summary, setSummary] = useState(initial);
  const [selected, setSelected] = useState<Member | null>(null);
  const [history, setHistory] = useState<MemberCredit | null>(null);
  const [query, setQuery] = useState('');
  const [movement, setMovement] = useState<Movement | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busy = useRef(false);
  // Lock synchronously before a write. Only a successful history + summary read unlocks it.
  const needsRead = useRef(false);
  const active = selected !== null && summary.eligibleMembers.some((m) => m.userId === selected.userId);
  // B5b-3: the DB forbids self top-up for every role, including owners.
  const topUpMembers = summary.eligibleMembers.filter((member) => member.userId !== currentUserId);
  const topUpEligible = active && selected?.userId !== currentUserId;
  const payoutEligible = selected !== null && summary.members.some((m) => m.userId === selected.userId);
  const ready = history !== null && history.userId === selected?.userId && !stale && !pending;
  const valid = /^\d+(\.\d{1,2})?$/.test(amount.trim()) && !isZeroAmount(amount.trim()) && !!reason.trim();
  const matches = (member: Member) => member.displayName.toLocaleLowerCase('th').includes(query.trim().toLocaleLowerCase('th'));

  function clearDraft() {
    setMovement(null); setAmount(''); setReason(''); setConfirm(false);
  }

  async function read(member: Member | null = selected) {
    if (busy.current) return;
    // An uncertain write must be reconciled for its original member, not another wallet.
    if (needsRead.current && member?.userId !== selected?.userId) return;
    busy.current = true; setPending(true); setError(null); clearDraft();
    setSelected(member); setHistory(null); setStale(true); needsRead.current = true;
    try {
      const detail = member ? await getMemberCredit(gangId, member.userId) : null;
      if (detail && !detail.success) { setError(actionError(detail.error)); return; }
      const result = await listGangCredits(gangId);
      if (!result.success) { setError(actionError(result.error)); return; }
      setSummary(result.data);
      setHistory(detail?.success ? detail.data : null);
      needsRead.current = false; setStale(false);
    } catch {
      setError(actionError({ code: 'INTERNAL_ERROR', message: '' }));
    } finally {
      busy.current = false; setPending(false);
    }
  }

  function begin(kind: Movement) {
    if (busy.current || needsRead.current || !ready) return;
    if (kind === 'topup' ? !canTopUp || !topUpEligible : !canPayOut || !payoutEligible) return;
    clearDraft(); setMovement(kind); setError(null); setNotice(null);
  }

  async function submit() {
    if (busy.current || needsRead.current || !ready || !confirm || !valid || !selected || !movement) return;
    if (movement === 'topup' ? !canTopUp || !topUpEligible : !canPayOut || !payoutEligible) return;
    busy.current = true; needsRead.current = true;
    setPending(true); setStale(true); setConfirm(false); setError(null); setNotice(null);
    try {
      const result = movement === 'topup'
        ? await topUpCredit(gangId, selected.userId, amount.trim(), reason.trim())
        : await payOutCredit(gangId, selected.userId, amount.trim(), reason.trim());
      // Even a returned failure may follow a committed write (e.g. revalidation failed).
      // Never replay: leave locked until the operator explicitly reads fresh history.
      clearDraft();
      if (!result.success) { setError(actionError(result.error)); return; }
      setNotice(`บันทึก${movement === 'topup' ? 'เติมเครดิต' : 'จ่ายคืนเงินสด'}แล้ว · ยอดหลังรายการ ${baht(result.data.balanceAfter)}`);
      const detail = await getMemberCredit(gangId, selected.userId);
      if (!detail.success) { setError(actionError(detail.error)); return; }
      const refreshed = await listGangCredits(gangId);
      if (!refreshed.success) { setError(actionError(refreshed.error)); return; }
      setHistory(detail.data); setSummary(refreshed.data);
      needsRead.current = false; setStale(false);
    } catch {
      clearDraft(); setError(actionError({ code: 'INTERNAL_ERROR', message: '' }));
    } finally {
      busy.current = false; setPending(false);
    }
  }

  return <VStack gap={6} className="mx-auto w-full max-w-4xl p-4" aria-busy={pending}>
    <Heading level={1}>กระเป๋าเครดิตสมาชิก</Heading>
    <Text type="supporting">เครดิตคือเงินที่ก๊วนติดสมาชิก แยกจากยอดค้างชำระ ไม่หักกลบกัน</Text>
    <Card padding={4}><VStack gap={2}>
      <Text>เครดิตสมาชิกคงค้างทั้งหมด</Text>
      <Text size="2xl" weight="semibold" hasTabularNumbers>{baht(summary.totalOwed)}</Text>
      <Text type="supporting">ยอดจากเซิร์ฟเวอร์ รวมอดีตสมาชิกที่ยังมีเครดิต</Text>
    </VStack></Card>
    {notice ? <Banner status="success" title={notice} /> : null}
    {error ? <Banner status="error" title={error} /> : null}
    {stale ? <Banner status="warning" title="ต้องอ่านประวัติล่าสุดก่อนทำรายการต่อ"
      description="คำขออาจบันทึกแล้ว ตรวจรายการล่าสุดก่อนเริ่มใหม่ ระบบไม่ส่งรายการเดิมซ้ำอัตโนมัติ" /> : null}
    <Button variant="ghost" label="โหลดประวัติและยอดล่าสุด" isDisabled={pending} onClick={() => read()} />

    {selected ? <VStack gap={4} as="section" aria-label="กระเป๋าที่เลือก">
      <Heading level={2}>เครดิตของ {selected.displayName}</Heading>
      {history ? <Text hasTabularNumbers>เครดิตคงเหลือ {baht(history.balance)}</Text> : <Text>ยังไม่มีประวัติที่อ่านสำเร็จ กรุณาโหลดข้อมูลล่าสุด</Text>}
      {!active ? <Text type="supporting">ไม่อยู่ในรายชื่อสมาชิกที่เติมเครดิตได้ แต่ยังจ่ายคืนเครดิตคงเหลือได้</Text> : null}
      <HStack gap={2} wrap="wrap">
        {canTopUp && topUpEligible ? <Button label="เติมเครดิต" isDisabled={!ready} onClick={() => begin('topup')} /> : null}
        {canPayOut && payoutEligible ? <Button label="จ่ายคืนเงินสด" isDisabled={!ready} onClick={() => begin('payout')} /> : null}
      </HStack>
      {movement ? <VStack gap={3} as="section" aria-label="ทำรายการเครดิต">
        <Heading level={3}>{confirm ? 'ขั้นที่ 2: ยืนยันรายการ' : 'ขั้นที่ 1: กรอกรายการ'} · {movement === 'topup' ? 'เติมเครดิต' : 'จ่ายคืนเงินสด'}</Heading>
        <Text>{movement === 'topup' ? 'ให้เครดิตแก่สมาชิก ไม่ใช่การบันทึกเงินสดรับเข้า' : 'บันทึกเงินที่จ่ายคืนสมาชิกจริง ไม่ใช่การรับเงินสดแทนสมาชิก ระบบตรวจเพดานยอดคงเหลืออีกครั้ง'}</Text>
        {confirm ? <>
          <Text>สมาชิก: {selected.displayName}</Text>
          <Text hasTabularNumbers>จำนวนเงิน: {baht(amount.trim())}</Text>
          <Text>เหตุผล: {reason.trim()}</Text>
          <Button variant="primary" label={movement === 'topup' ? 'ยืนยันเติมเครดิต' : 'ยืนยันว่าจ่ายคืนเงินสดแล้ว'} isDisabled={!ready || !valid} onClick={submit} />
          <Button label="กลับไปแก้ไข" isDisabled={pending} onClick={() => setConfirm(false)} />
        </> : <>
          <TextInput label="จำนวนเงิน (บาท)" description="ใช้ตัวเลขและทศนิยมไม่เกิน 2 ตำแหน่ง ไม่ใส่เครื่องหมายคั่นหลักพัน" value={amount} onChange={setAmount} isRequired isDisabled={!ready} />
          <TextInput label="เหตุผล" value={reason} onChange={setReason} isRequired isDisabled={!ready} />
          <Button variant="primary" label="ตรวจทานและไปหน้ายืนยัน" isDisabled={!ready || !valid} onClick={() => { if (!busy.current && !needsRead.current) setConfirm(true); }} />
        </>}
        <Button variant="ghost" label="ยกเลิกรายการ" isDisabled={pending} onClick={clearDraft} />
      </VStack> : null}
      <Heading level={3}>ประวัติเครดิตล่าสุด</Heading>
      <Text type="supporting">สูงสุด 50 รายการ เรียงล่าสุดก่อน · เครื่องหมาย + คือเข้า − คือออก · เวลาไทย</Text>
      {history?.entries.length === 0 ? <Text>ยังไม่มีรายการเครดิต</Text> : null}
      {history?.entries.map((entry) => <VStack key={entry.id} gap={1} paddingBlock={2}>
        <HStack gap={2} justify="between" wrap="wrap">
          <Text weight="semibold">{ENTRY_LABEL[entry.type]}</Text>
          <Text hasTabularNumbers>{entry.amount.startsWith('-') || isZeroAmount(entry.amount) ? baht(entry.amount) : `+${baht(entry.amount)}`}</Text>
        </HStack>
        <Text type="supporting">{utcToZonedWallClock(new Date(entry.createdAt), 'Asia/Bangkok').replace('T', ' ')} · ลำดับ {entry.seq}</Text>
        <Text hasTabularNumbers>ยอดหลังรายการ {baht(entry.balanceAfter)}</Text>
        <Text>เหตุผล: {entry.reason ?? 'ไม่ได้ระบุ'}</Text>
        {entry.paymentId ? <Button variant="ghost" label="ดูใบจ่ายที่เกี่ยวข้อง" href={`/gangs/${gangId}/payments/${entry.paymentId}`} /> : null}
      </VStack>)}
    </VStack> : <Text>เลือกสมาชิกเพื่อดูประวัติหรือทำรายการ</Text>}

    <TextInput label="ค้นหาสมาชิก" value={query} onChange={setQuery} />
    <VStack gap={3} as="section" aria-label="สมาชิกที่มีเครดิตคงเหลือ">
      <Heading level={2}>ผู้มีเครดิตคงเหลือ</Heading>
      <Text type="supporting">รวมผู้ที่ออกจากก๊วนแล้ว ไม่ตัดสิทธิ์จ่ายคืนเพราะพ้นสมาชิก</Text>
      {summary.members.filter(matches).length === 0 ? <Text>ไม่พบผู้มีเครดิตคงเหลือที่ตรงกับการค้นหา</Text> : null}
      {summary.members.filter(matches).map((member) => <HStack key={member.userId} gap={3} justify="between" wrap="wrap">
        <Text>{member.displayName}</Text><Text hasTabularNumbers>{baht(member.balance)}</Text>
        <Button label={`ดูเครดิต ${member.displayName}`} isDisabled={pending || stale} onClick={() => { setNotice(null); void read(member); }} />
      </HStack>)}
    </VStack>
    {canTopUp ? <VStack gap={3} as="section" aria-label="สมาชิกที่เติมเครดิตได้">
      <Heading level={2}>สมาชิกที่เติมเครดิตได้</Heading>
      <Text type="supporting">เฉพาะสมาชิกปัจจุบัน รวมผู้ที่ยังไม่เคยมีกระเป๋าเครดิต · เติมให้ตัวเองไม่ได้ ต้องให้แอดมินคนอื่นทำแทน</Text>
      {topUpMembers.filter(matches).length === 0 ? <Text>ไม่พบสมาชิกที่เติมเครดิตได้ที่ตรงกับการค้นหา</Text> : null}
      {topUpMembers.filter(matches).map((member) => <HStack key={member.userId} gap={3} justify="between" wrap="wrap">
        <Text>{member.displayName}</Text><Text hasTabularNumbers>{baht(member.balance)}</Text>
        <Button label={`เลือกเติมเครดิต ${member.displayName}`} isDisabled={pending || stale} onClick={() => { setNotice(null); void read(member); }} />
      </HStack>)}
    </VStack> : null}
    <Button variant="ghost" label="กลับหน้าการเงิน" href={`/gangs/${gangId}/payments`} />
  </VStack>;
}
