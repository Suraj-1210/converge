"use client";

import { createContext, useContext } from "react";
import { api } from "~/trpc/react";

// Where the student profile tabs save to. The same Personal / Academic /
// Work / Tests forms serve the admin profile (default) and the partner
// profile at /partner/students/[id], which provides partner-scoped
// procedures with identical inputs and outputs.
export interface StudentProfileApi {
  useUpdateProfile: typeof api.students.adminUpdate.useMutation;
  useSaveEducation: typeof api.students.saveEducation.useMutation;
  useSaveWork: typeof api.students.saveWorkExperience.useMutation;
  useSaveTests: typeof api.students.saveTestScores.useMutation;
  // Returns a function that refreshes the profile (and its list) after a save.
  useRefresh: () => (studentId: number) => void;
  uploadUrl: string;
  // Partners can add files but not remove them.
  canDeleteDocuments: boolean;
}

function useAdminRefresh() {
  const utils = api.useUtils();
  return (id: number) => {
    void utils.students.adminGet.invalidate({ id });
    void utils.students.adminList.invalidate();
  };
}

export const ADMIN_PROFILE_API: StudentProfileApi = {
  useUpdateProfile: api.students.adminUpdate.useMutation,
  useSaveEducation: api.students.saveEducation.useMutation,
  useSaveWork: api.students.saveWorkExperience.useMutation,
  useSaveTests: api.students.saveTestScores.useMutation,
  useRefresh: useAdminRefresh,
  uploadUrl: "/api/admin/student-doc",
  canDeleteDocuments: true,
};

const ProfileApiContext = createContext<StudentProfileApi>(ADMIN_PROFILE_API);

export const StudentProfileApiProvider = ProfileApiContext.Provider;
export const useStudentProfileApi = () => useContext(ProfileApiContext);
