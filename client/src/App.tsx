import { useEffect, useRef } from 'react';
import { client } from './lib/room-client.ts';
import { useClient } from './lib/hooks.ts';
import { navigate, roomCodeFrom, usePath } from './lib/router.ts';
import { AmbientProvider } from './components/AmbientCanvas.tsx';
import { JoinGate } from './components/JoinGate.tsx';
import { Landing } from './components/Landing.tsx';
import { RoomView } from './components/RoomView.tsx';
import { Toasts } from './components/ui.tsx';

export function App() {
  const path = usePath();
  const { phase, room, me } = useClient();
  const code = roomCodeFrom(path);
  const inRoom = phase.name === 'in-room' && room && me;

  // The address always names the room you are in, so a reload or a shared link lands in the same place.
  useEffect(() => {
    if (inRoom && roomCodeFrom(location.pathname) !== room.code) navigate(`/r/${room.code}`, !code);
  }, [inRoom, room?.code, code]);

  // Leaving via the browser's back button leaves the room too — but only after
  // the address has actually been on the room, not in the moment right after creating it.
  const shownRoom = useRef(false);
  useEffect(() => {
    if (inRoom && code === room.code) shownRoom.current = true;
    else if (inRoom && !code && shownRoom.current) {
      shownRoom.current = false;
      client.leave();
    }
  }, [inRoom, code, room?.code]);

  return (
    <AmbientProvider>
      {inRoom ? <RoomView room={room} me={me} /> : code ? <JoinGate code={code} /> : <Landing />}
      <Toasts />
    </AmbientProvider>
  );
}
