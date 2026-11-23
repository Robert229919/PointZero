using System.Runtime.InteropServices;

static class XInput
{
    [StructLayout(LayoutKind.Sequential)]
    public struct Gamepad
    {
        public ushort wButtons;
        public byte bLeftTrigger, bRightTrigger;
        public short sThumbLX, sThumbLY, sThumbRX, sThumbRY;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct State
    {
        public uint dwPacketNumber;
        public Gamepad Gamepad;
    }

    [DllImport("xinput1_4.dll")]
    public static extern uint XInputGetState(uint index, ref State state);
}
