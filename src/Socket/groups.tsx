import { proto } from '../../WAProto'
import { GroupMetadata, ParticipantAction, WAMessageKey, WAMessageStubType } from '../Types'
import { generateMessageID, unixTimestampSeconds } from '../Utils'
import { BinaryNode, getBinaryNodeChild, getBinaryNodeChildren, getBinaryNodeChildString, jidEncode, jidNormalizedUser } from '../WABinary'
import { Chats } from './chats'

export class Groups extends Chats {

	groupQuery = async(jid: string, type: 'get' | 'set', content: BinaryNode[]) => (
		this.query(
			<iq to={jid} type={type} xmlns="w:g2">
				{content}
			</iq>
		)
	)

	groupMetadata = async(jid: string) => {
		const result = await this.groupQuery(
			jid,
			'get',
			[ <query request="interactive" /> ]
		)
		return extractGroupMetadata(result)
	}

	groupCreate = async(subject: string, participants: string[]) => {
		const key = generateMessageID()
		const result = await this.groupQuery(
			'@g.us',
			'set',
			[
				<create subject={subject} key={key}>
					{participants.map(jid => <participant jid={jid} />)}
				</create>
			]
		)
		return extractGroupMetadata(result)
	}
	groupLeave = async(id: string) => {
		await this.groupQuery(
			'@g.us',
			'set',
			[
				<leave>
					<group id={id} />
				</leave>
			]
		)
	}
	groupUpdateSubject = async(jid: string, subject: string) => {
		await this.groupQuery(
			jid,
			'set',
			[
				<subject>{Buffer.from(subject, 'utf-8')}</subject>
			]
		)
	}
	groupParticipantsUpdate = async(
		jid: string,
		participants: string[],
		action: ParticipantAction
	) => {
		const result = await this.groupQuery(
			jid,
			'set',
			[
				{
					tag: action,
					attrs: { },
					content: participants.map(jid => <participant jid={jid} />)
				},
			]
		)
		const node = getBinaryNodeChild(result, action)
		const participantsAffected = getBinaryNodeChildren(node!, 'participant')
		return participantsAffected.map(p => {
			return { status: p.attrs.error || '200', jid: p.attrs.jid }
		})
	}
	groupUpdateDescription = async(jid: string, description?: string) => {
		const metadata = await this.groupMetadata(jid)
		const prev = metadata.descId ?? null

		await this.groupQuery(
			jid,
			'set',
			[
				<description {...(prev ? { prev } : {})} {...(description ? { id: generateMessageID() } : { delete: 'true' })}>
					{description ? <body>{Buffer.from(description, 'utf-8')}</body> : undefined}
				</description>
			]
		)
	}
	groupInviteCode = async(jid: string) => {
		const result = await this.groupQuery(jid, 'get', [<invite />])
		const inviteNode = getBinaryNodeChild(result, 'invite')
		return inviteNode?.attrs.code
	}
	groupRevokeInvite = async(jid: string) => {
		const result = await this.groupQuery(jid, 'set', [<invite />])
		const inviteNode = getBinaryNodeChild(result, 'invite')
		return inviteNode?.attrs.code
	}
	groupAcceptInvite = async(code: string) => {
		const results = await this.groupQuery('@g.us', 'set', [<invite code={code} />])
		const result = getBinaryNodeChild(results, 'group')
		return result?.attrs.jid
	}
	/**
	 * accept a GroupInviteMessage
	 * @param key the key of the invite message, or optionally only provide the jid of the person who sent the invite
	 * @param inviteMessage the message to accept
	 */
	groupAcceptInviteV4 = this.ev.createBufferedFunction(async(key: string | WAMessageKey, inviteMessage: proto.Message.IGroupInviteMessage) => {
		key = typeof key === 'string' ? { remoteJid: key } : key
		const results = await this.groupQuery(inviteMessage.groupJid!, 'set', [
			<accept code={inviteMessage.inviteCode!} expiration={inviteMessage.inviteExpiration!.toString()} admin={key.remoteJid!} />
		])

		// if we have the full message key
		// update the invite message to be expired
		if(key.id) {
			// create new invite message that is expired
			inviteMessage = proto.Message.GroupInviteMessage.fromObject(inviteMessage)
			inviteMessage.inviteExpiration = 0
			inviteMessage.inviteCode = ''
			this.ev.emit('messages.update', [
				{
					key,
					update: {
						message: {
							groupInviteMessage: inviteMessage
						}
					}
				}
			])
		}

		// generate the group add message
		await this.upsertMessage(
			{
				key: {
					remoteJid: inviteMessage.groupJid,
					id: generateMessageID(),
					fromMe: false,
					participant: key.remoteJid,
				},
				messageStubType: WAMessageStubType.GROUP_PARTICIPANT_ADD,
				messageStubParameters: [
					this.authState.creds.me!.id
				],
				participant: key.remoteJid,
				messageTimestamp: unixTimestampSeconds()
			},
			'notify'
		)

		return results.attrs.from
	})
	groupGetInviteInfo = async(code: string) => {
		const results = await this.groupQuery('@g.us', 'get', [<invite code={code} />])
		return extractGroupMetadata(results)
	}
	groupToggleEphemeral = async(jid: string, ephemeralExpiration: number) => {
		const content: BinaryNode = ephemeralExpiration ?
			<ephemeral expiration={ephemeralExpiration.toString()} /> :
			<not_ephemeral />

		await this.groupQuery(jid, 'set', [content])
	}
	groupSettingUpdate = async(jid: string, setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked') => {
		await this.groupQuery(jid, 'set', [ { tag: setting, attrs: { } } ])
	}
	groupFetchAllParticipating = async() => {
		const result = await this.query(
			<iq to="@g.us" xmlns="w:g2" type="get">
				<participating>
					<participants />
					<description />
				</participating>
			</iq>
		)
		const data: { [_: string]: GroupMetadata } = { }
		const groupsChild = getBinaryNodeChild(result, 'groups')
		if(groupsChild) {
			const groups = getBinaryNodeChildren(groupsChild, 'group')
			for(const groupNode of groups) {
				const meta = extractGroupMetadata(<result>{groupNode}</result>)
				data[meta.id] = meta
			}
		}

		return data
	}
}


export const extractGroupMetadata = (result: BinaryNode) => {
	const group = getBinaryNodeChild(result, 'group')!
	const descChild = getBinaryNodeChild(group, 'description')
	let desc: string | undefined
	let descId: string | undefined
	if(descChild) {
		desc = getBinaryNodeChildString(descChild, 'body')
		descId = descChild.attrs.id
	}

	const groupId = group.attrs.id.includes('@') ? group.attrs.id : jidEncode(group.attrs.id, 'g.us')
	const eph = getBinaryNodeChild(group, 'ephemeral')?.attrs.expiration
	const metadata: GroupMetadata = {
		id: groupId,
		subject: group.attrs.subject,
		subjectOwner: group.attrs.s_o,
		subjectTime: +group.attrs.s_t,
		size: +group.attrs.size,
		creation: +group.attrs.creation,
		owner: group.attrs.creator ? jidNormalizedUser(group.attrs.creator) : undefined,
		desc,
		descId,
		restrict: !!getBinaryNodeChild(group, 'locked'),
		announce: !!getBinaryNodeChild(group, 'announcement'),
		participants: getBinaryNodeChildren(group, 'participant').map(
			({ attrs }) => {
				return {
					id: attrs.jid,
					admin: attrs.type || null as any,
				}
			}
		),
		ephemeralDuration: eph ? +eph : undefined
	}
	return metadata
}
