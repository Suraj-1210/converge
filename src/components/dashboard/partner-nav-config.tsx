import {
  CalendarIcon,
  ChatIcon,
  CommissionIcon,
  BankIcon,
  DashboardIcon,
  InvoiceIcon,
  ResourcesIcon,
  SearchIcon,
  StudentsIcon,
  UsersIcon,
} from "./nav-icons";
import { type NavSection } from "./nav-config";

export const PARTNER_NAV_SECTIONS: NavSection[] = [
  {
    label: "Main",
    items: [
      { label: "Dashboard", href: "/partner/dashboard", icon: <DashboardIcon /> },
      {
        label: "Students",
        href: "/partner/students",
        icon: <StudentsIcon />,
        badgeKey: "students",
      },
      // Every application across the partner's students (27 Oct testing).
      { label: "Applications", href: "/partner/applications", icon: <InvoiceIcon /> },
      // Chat with Collegepond, one thread per student. Badge: unread threads.
      { label: "Chat", href: "/partner/chat", icon: <ChatIcon />, badgeKey: "chat" },
      // Education-loan referrals to Collegepond's loan team and their progress.
      // Badge: loans with chat messages from the loan team not yet read.
      { label: "Loans", href: "/partner/loans", icon: <BankIcon />, badgeKey: "loans" },
      { label: "Uni Assist", href: "/partner/uni-assist", icon: <SearchIcon /> },
      { label: "Counsellors", href: "/partner/counsellors", icon: <UsersIcon /> },
    ],
  },
  {
    label: "Finance",
    items: [
      {
        label: "Commission",
        href: "/partner/commission",
        icon: <CommissionIcon />,
      },
    ],
  },
  {
    label: "Support",
    items: [
      {
        label: "Resources",
        href: "/partner/resources",
        icon: <ResourcesIcon />,
      },
      {
        label: "Upcoming Events",
        href: "/partner/events",
        icon: <CalendarIcon />,
      },
    ],
  },
];
